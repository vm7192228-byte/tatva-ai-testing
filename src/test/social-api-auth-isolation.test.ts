import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));

import { handleSocialApiRequest } from "../lib/social-api.server";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "social-token-secret-that-is-long-enough-for-tests";
const runtimeEnv = {
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  SOCIAL_TOKEN_SECRET: secret,
};

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function sealToken(value: Record<string, unknown>): Promise<string> {
  const keyBytes = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return base64Url(iv) + "." + base64Url(new Uint8Array(ciphertext));
}

function authSession(userId: string | null) {
  return {
    configured: true,
    user: userId ? { id: userId, email: "user@example.com", displayName: "Test user", avatarUrl: "" } : null,
    cookies: [],
  };
}

async function unsealToken(value: string): Promise<Record<string, unknown>> {
  const [ivValue, ciphertextValue] = value.split(".");
  if (!ivValue || !ciphertextValue) throw new Error("Invalid sealed test token.");
  const keyBytes = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(ivValue, "base64url") },
    key,
    Buffer.from(ciphertextValue, "base64url"),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

function readSetCookieValue(header: string, name: string): string {
  const match = header.match(new RegExp("(?:^|,\\s*)" + name + "=([^;,]+)"));
  const value = match?.[1];
  return value ? decodeURIComponent(value) : "";
}

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("social OAuth account isolation", () => {
  it("does not expose one CodeForge user's YouTube connection to another account", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(otherUserId));
    const token = await sealToken({
      owner_user_id: ownerId,
      access_token: "owner-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/status", {
        headers: { cookie: "cf_social_youtube=" + encodeURIComponent(token) },
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { youtube?: { connected?: boolean } };

    expect(response?.status).toBe(200);
    expect(payload.youtube?.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the connection available to the CodeForge account that owns it", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const token = await sealToken({
      owner_user_id: ownerId,
      access_token: "owner-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/status", {
        headers: { cookie: "cf_social_youtube=" + encodeURIComponent(token) },
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { youtube?: { connected?: boolean } };

    expect(response?.status).toBe(200);
    expect(payload.youtube?.connected).toBe(true);
  });

  it("rejects legacy social cookies that have no CodeForge owner binding", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const token = await sealToken({
      access_token: "legacy-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/status", {
        headers: { cookie: "cf_social_youtube=" + encodeURIComponent(token) },
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { youtube?: { connected?: boolean } };

    expect(response?.status).toBe(200);
    expect(payload.youtube?.connected).toBe(false);
  });

  it("requires a signed-in CodeForge account before starting social OAuth", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(null));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/youtube/connect"),
      runtimeEnv,
    );
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(401);
    expect(payload.error).toBe("AUTH_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds the OAuth state cookie to the signed-in CodeForge account", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/youtube/connect"),
      runtimeEnv,
    );
    const cookie = response?.headers.get("set-cookie") ?? "";

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toContain("accounts.google.com");
    expect(cookie).toContain("cf_oauth_state_youtube=");
    expect(cookie).toContain("." + ownerId);
  });

  it("does not let another CodeForge account disconnect the owner's social token", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(otherUserId));
    const token = await sealToken({
      owner_user_id: ownerId,
      access_token: "owner-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/youtube/disconnect", {
        method: "POST",
        headers: {
          origin: "https://app.example",
          cookie: "cf_social_youtube=" + encodeURIComponent(token),
        },
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie") ?? "").not.toContain("cf_social_youtube=");
  });

  it("still permits public YouTube search for guests when a server API key is configured", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(null));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: { videoId: "abcdefghijk" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "abcdefghijk",
          snippet: {
            title: "Public video",
            description: "Public description",
            channelTitle: "Public channel",
            publishedAt: "2026-01-01T00:00:00Z",
            thumbnails: { medium: { url: "https://example.com/thumb.jpg" } },
          },
          contentDetails: { duration: "PT1M" },
          statistics: { viewCount: "100", likeCount: "5", commentCount: "2" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/youtube/search?q=public+demo"),
      { ...runtimeEnv, YOUTUBE_API_KEY: "server-youtube-api-key" },
    );
    const payload = await response?.json() as { query?: string; videos?: Array<{ id: string }> };

    expect(response?.status).toBe(200);
    expect(payload.query).toBe("public demo");
    expect(payload.videos?.[0]?.id).toBe("abcdefghijk");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets the owning CodeForge account disconnect its own social token", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const token = await sealToken({
      owner_user_id: ownerId,
      access_token: "owner-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/youtube/disconnect", {
        method: "POST",
        headers: {
          origin: "https://app.example",
          cookie: "cf_social_youtube=" + encodeURIComponent(token),
        },
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie") ?? "").toContain("cf_social_youtube=");
    expect(response?.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("rejects an oversized YouTube thumbnail before parsing multipart data", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const token = await sealToken({
      owner_user_id: ownerId,
      access_token: "owner-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });
    const request = new Request("https://app.example/api/social/youtube/thumbnail-update", {
      method: "POST",
      headers: {
        origin: "https://app.example",
        cookie: "cf_social_youtube=" + encodeURIComponent(token),
        "content-type": "multipart/form-data; boundary=test",
        "content-length": "2400001",
      },
    });
    const parseForm = vi.fn();
    Object.defineProperty(request, "formData", { value: parseForm });

    const response = await handleSocialApiRequest(request, runtimeEnv);
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(413);
    expect(payload.error).toBe("THUMBNAIL_TOO_LARGE");
    expect(parseForm).not.toHaveBeenCalled();
  });

  it("rejects oversized YouTube video uploads before parsing multipart data", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const token = await sealToken({
      owner_user_id: ownerId,
      access_token: "owner-youtube-access-token",
      expires_at: Date.now() + 60 * 60_000,
    });
    const request = new Request("https://app.example/api/social/youtube/upload", {
      method: "POST",
      headers: {
        origin: "https://app.example",
        cookie: "cf_social_youtube=" + encodeURIComponent(token),
        "content-type": "multipart/form-data; boundary=test",
        "content-length": "2800001",
      },
    });
    const parseForm = vi.fn();
    Object.defineProperty(request, "formData", { value: parseForm });

    const response = await handleSocialApiRequest(request, runtimeEnv);
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(413);
    expect(payload.error).toBe("YOUTUBE_VIDEO_UPLOAD_TOO_LARGE");
    expect(parseForm).not.toHaveBeenCalled();
  });

  it("rejects an OAuth callback completed under a different CodeForge account", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(otherUserId));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/youtube/callback?code=provider-code&state=oauth-state", {
        headers: { cookie: "cf_oauth_state_youtube=oauth-state." + ownerId },
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toContain("status=error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Meta OAuth app secrets are obvious placeholders", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const configuredEnv = {
      ...runtimeEnv,
      META_APP_ID: "meta-app-id",
      META_APP_SECRET: "YOUR_META_APP_SECRET",
      INSTAGRAM_APP_ID: "instagram-app-id",
      INSTAGRAM_APP_SECRET: "PLACEHOLDER_ONLY",
    };

    const statusResponse = await handleSocialApiRequest(
      new Request("https://app.example/api/social/status"),
      configuredEnv,
    );
    const status = await statusResponse?.json() as {
      facebook?: { configured?: boolean; missing?: string[] };
      instagram?: { configured?: boolean; missing?: string[] };
    };

    expect(status.facebook?.configured).toBe(false);
    expect(status.facebook?.missing).toContain("META_APP_SECRET");
    expect(status.instagram?.configured).toBe(false);
    expect(status.instagram?.missing).toContain("INSTAGRAM_APP_SECRET");

    for (const provider of ["facebook", "instagram"] as const) {
      const response = await handleSocialApiRequest(
        new Request("https://app.example/api/social/" + provider + "/connect"),
        configuredEnv,
      );
      const payload = await response?.json() as { error?: string; missing?: string[] };
      expect(response?.status).toBe(503);
      expect(payload.error).toBe("NOT_CONFIGURED");
      expect(payload.missing).toContain(provider === "facebook" ? "META_APP_SECRET" : "INSTAGRAM_APP_SECRET");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts Facebook basic login with identity scopes only", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/facebook/connect"),
      {
        ...runtimeEnv,
        META_APP_ID: "meta-app-id",
        META_APP_SECRET: "meta-app-secret",
      },
    );
    const authorizationUrl = new URL(response?.headers.get("location") ?? "https://invalid.example");

    expect(response?.status).toBe(302);
    expect(authorizationUrl.origin).toBe("https://www.facebook.com");
    expect(authorizationUrl.pathname).toBe("/v26.0/dialog/oauth");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("meta-app-id");
    expect(authorizationUrl.searchParams.get("scope")).toBe("email,public_profile");
    expect(authorizationUrl.searchParams.get("scope")).not.toContain("pages_");
    expect(authorizationUrl.searchParams.get("scope")).not.toContain("read_insights");
    expect(response?.headers.get("set-cookie") ?? "").toContain("cf_oauth_state_facebook=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests Facebook Page permissions only from the explicit connect-page flow", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/facebook/connect-page"),
      {
        ...runtimeEnv,
        META_APP_ID: "meta-app-id",
        META_APP_SECRET: "meta-app-secret",
      },
    );
    const authorizationUrl = new URL(response?.headers.get("location") ?? "https://invalid.example");

    expect(response?.status).toBe(302);
    expect(authorizationUrl.origin).toBe("https://www.facebook.com");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,pages_manage_posts,read_insights",
    );
    expect(authorizationUrl.searchParams.get("auth_type")).toBe("rerequest");
    expect(response?.headers.get("set-cookie") ?? "").toContain("cf_oauth_state_facebook_page=");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("completes Facebook basic login without requesting or storing Page permissions", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "facebook-short-token" }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "facebook-long-token", expires_in: 5_184_000 }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "fb-user-123", name: "Test Facebook User" }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/facebook/callback?code=facebook-code&state=facebook-state", {
        headers: { cookie: "cf_oauth_state_facebook=facebook-state." + ownerId },
      }),
      {
        ...runtimeEnv,
        META_APP_ID: "meta-app-id",
        META_APP_SECRET: "meta-app-secret",
      },
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toContain("social=facebook&status=connected");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain("/oauth/access_token?");
    expect(String((fetchMock.mock.calls[1] as [string])[0])).toContain("fb_exchange_token");
    expect(String((fetchMock.mock.calls[2] as [string])[0])).toContain("/me?");

    const requestedUrls = fetchMock.mock.calls.map(call => String((call as [string])[0]));
    expect(requestedUrls.some(value => value.includes("/me/accounts"))).toBe(false);
    const sealed = readSetCookieValue(response?.headers.get("set-cookie") ?? "", "cf_social_facebook");
    const token = await unsealToken(sealed);
    expect(token["owner_user_id"]).toBe(ownerId);
    expect(token["login_method"]).toBe("facebook");
    expect(token["access_token"]).toBe("facebook-long-token");
    expect(token["profile"]).toEqual(expect.objectContaining({ id: "fb-user-123", name: "Test Facebook User" }));
    expect(token["pages"]).toEqual([]);
  });

  it("adds Facebook Page tokens only after the separately approved Page callback", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "facebook-page-short-token" }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "facebook-page-long-token", expires_in: 5_184_000 }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          id: "fb-page-456",
          name: "CodeForge Page",
          access_token: "facebook-page-token",
          instagram_business_account: { id: "instagram-pro-789" },
          tasks: ["ANALYZE", "CREATE_CONTENT", "MANAGE"],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "fb-user-123", name: "Test Facebook User" }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/facebook/callback?code=facebook-page-code&state=facebook-page-state", {
        headers: { cookie: "cf_oauth_state_facebook_page=facebook-page-state." + ownerId },
      }),
      {
        ...runtimeEnv,
        META_APP_ID: "meta-app-id",
        META_APP_SECRET: "meta-app-secret",
      },
    );

    expect(response?.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String((fetchMock.mock.calls[2] as [string])[0])).toContain("/me/accounts?");
    const sealed = readSetCookieValue(response?.headers.get("set-cookie") ?? "", "cf_social_facebook");
    const token = await unsealToken(sealed);
    expect(token["owner_user_id"]).toBe(ownerId);
    expect(token["login_method"]).toBe("facebook");
    expect(token["pages"]).toEqual([
      expect.objectContaining({
        id: "fb-page-456",
        name: "CodeForge Page",
        token: "facebook-page-token",
        ig: "instagram-pro-789",
        tasks: ["ANALYZE", "CREATE_CONTENT", "MANAGE"],
      }),
    ]);
    expect(response?.headers.get("set-cookie") ?? "").toContain("cf_oauth_state_facebook_page=");
  });

  it("starts Instagram Business Login with Instagram credentials and Instagram scopes", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/instagram/connect"),
      {
        ...runtimeEnv,
        INSTAGRAM_APP_ID: "instagram-app-id",
        INSTAGRAM_APP_SECRET: "instagram-app-secret",
      },
    );
    const authorizationUrl = new URL(response?.headers.get("location") ?? "https://invalid.example");

    expect(response?.status).toBe(302);
    expect(authorizationUrl.origin).toBe("https://www.instagram.com");
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("instagram-app-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://app.example/api/social/instagram/callback");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights",
    );
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
    expect(response?.headers.get("set-cookie") ?? "").toContain("cf_oauth_state_instagram=");
  });

  it("exchanges Instagram Login code for a long-lived token and stores an owner-bound direct account", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "instagram-short-token",
        user_id: "ig-user-123",
        username: "codeforge_creator",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "instagram-long-token",
        expires_in: 5_184_000,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user_id: "ig-user-123",
        username: "codeforge_creator",
        account_type: "BUSINESS",
        followers_count: 321,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/instagram/callback?code=one-time-code%23_&state=instagram-state", {
        headers: { cookie: "cf_oauth_state_instagram=instagram-state." + ownerId },
      }),
      {
        ...runtimeEnv,
        INSTAGRAM_APP_ID: "instagram-app-id",
        INSTAGRAM_APP_SECRET: "instagram-app-secret",
      },
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toContain("social=instagram&status=connected");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [shortUrl, shortOptions] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(shortUrl)).toBe("https://api.instagram.com/oauth/access_token");
    expect(shortOptions.method).toBe("POST");
    expect(shortOptions.body).toBeInstanceOf(FormData);
    expect((shortOptions.body as FormData).get("client_id")).toBe("instagram-app-id");
    expect((shortOptions.body as FormData).get("code")).toBe("one-time-code");

    const [longUrl] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(String(longUrl)).toContain("https://graph.instagram.com/v26.0/access_token?");
    expect(String(longUrl)).toContain("grant_type=ig_exchange_token");
    expect(String(longUrl)).not.toContain("graph.facebook.com");

    const [profileUrl, profileOptions] = fetchMock.mock.calls[2] as [string | URL, RequestInit];
    expect(String(profileUrl)).toContain("https://graph.instagram.com/v26.0/me?");
    expect(new Headers(profileOptions.headers).get("authorization")).toBe("Bearer instagram-long-token");

    const sealed = readSetCookieValue(response?.headers.get("set-cookie") ?? "", "cf_social_instagram");
    expect(sealed).toBeTruthy();
    const token = await unsealToken(sealed);
    expect(token["owner_user_id"]).toBe(ownerId);
    expect(token["login_method"]).toBe("instagram");
    expect(token["access_token"]).toBe("instagram-long-token");
    expect(token["expires_at"]).toBeGreaterThan(Date.now());
    expect(token["pages"]).toEqual([
      expect.objectContaining({
        id: "ig-user-123",
        name: "codeforge_creator",
        token: "instagram-long-token",
        ig: "ig-user-123",
      }),
    ]);
  });

  it("refreshes a direct Instagram Login token using the Instagram Graph host only", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(authSession(ownerId));
    const token = await sealToken({
      owner_user_id: ownerId,
      login_method: "instagram",
      access_token: "instagram-expiring-token",
      expires_at: Date.now() + 2 * 24 * 60 * 60 * 1000,
      pages: [{
        id: "ig-user-123",
        name: "codeforge_creator",
        token: "instagram-expiring-token",
        ig: "ig-user-123",
      }],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "instagram-refreshed-token",
      expires_in: 5_184_000,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleSocialApiRequest(
      new Request("https://app.example/api/social/status", {
        headers: { cookie: "cf_social_instagram=" + encodeURIComponent(token) },
      }),
      {
        ...runtimeEnv,
        INSTAGRAM_APP_ID: "instagram-app-id",
        INSTAGRAM_APP_SECRET: "instagram-app-secret",
      },
    );
    const payload = await response?.json() as { instagram?: { connected?: boolean } };

    expect(response?.status).toBe(200);
    expect(payload.instagram?.connected).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [refreshUrl] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(refreshUrl)).toContain("https://graph.instagram.com/v26.0/refresh_access_token?");
    expect(String(refreshUrl)).toContain("grant_type=ig_refresh_token");
    expect(String(refreshUrl)).not.toContain("graph.facebook.com");

    const sealed = readSetCookieValue(response?.headers.get("set-cookie") ?? "", "cf_social_instagram");
    const refreshedToken = await unsealToken(sealed);
    expect(refreshedToken["access_token"]).toBe("instagram-refreshed-token");
    expect((refreshedToken["pages"] as Array<{ token: string }> | undefined)?.[0]?.token).toBe("instagram-refreshed-token");
  });

});
