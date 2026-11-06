import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeSharedRateLimit: vi.fn(),
}));

vi.mock("../lib/shared-rate-limit.server", () => ({
  consumeSharedRateLimit: mocks.consumeSharedRateLimit,
}));

import { getAuthenticatedSession, handleAuthApiRequest } from "../lib/auth-api.server";

const runtimeEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_ANON_KEY: "publishable-test-key",
};

function logoutRequest(headers: Record<string, string> = {}) {
  return new Request("https://codeforge.example/api/auth/logout", {
    method: "POST",
    headers,
  });
}

function authPost(path: string, body: Record<string, unknown>) {
  return new Request("https://codeforge.example" + path, {
    method: "POST",
    headers: { origin: "https://codeforge.example", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.consumeSharedRateLimit.mockResolvedValue({
    allowed: true,
    attempts: 1,
    retryAfterSeconds: 0,
  });
});

afterEach(() => {
  mocks.consumeSharedRateLimit.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authentication same-origin protection", () => {
  it("rejects auth POSTs without Origin or same-origin Fetch Metadata", async () => {
    const response = await handleAuthApiRequest(logoutRequest(), runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(403);
    expect(payload).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
    expect(mocks.consumeSharedRateLimit).not.toHaveBeenCalled();
  });

  it("rejects cross-site Fetch Metadata when Origin is missing", async () => {
    const response = await handleAuthApiRequest(
      logoutRequest({ "sec-fetch-site": "cross-site" }),
      runtimeEnv,
    );

    expect(response?.status).toBe(403);
    expect(mocks.consumeSharedRateLimit).not.toHaveBeenCalled();
  });

  it("accepts an explicitly same-origin browser POST without an Origin header", async () => {
    const response = await handleAuthApiRequest(
      logoutRequest({ "sec-fetch-site": "same-origin" }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
  });

  it("accepts a matching Origin and rejects a foreign Origin", async () => {
    const sameOriginResponse = await handleAuthApiRequest(
      logoutRequest({ origin: "https://codeforge.example" }),
      runtimeEnv,
    );
    const crossOriginResponse = await handleAuthApiRequest(
      logoutRequest({ origin: "https://attacker.example" }),
      runtimeEnv,
    );

    expect(sameOriginResponse?.status).toBe(200);
    expect(crossOriginResponse?.status).toBe(403);
  });

  it("revokes only the current Supabase session before clearing browser cookies", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth/v1/user") && init?.method === "GET") {
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          user_metadata: { display_name: "Creator" },
        });
      }
      if (url.pathname.endsWith("/auth/v1/logout") && init?.method === "POST") {
        expect(url.searchParams.get("scope")).toBe("local");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-access");
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected Supabase auth request: " + url.pathname);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleAuthApiRequest(
      logoutRequest({ origin: "https://codeforge.example", cookie: "cf_access=test-access; cf_refresh=test-refresh" }),
      runtimeEnv,
    );
    const payload = await response?.json();
    const setCookie = response?.headers.get("set-cookie") || "";

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setCookie).toContain("cf_access=");
    expect(setCookie).toContain("cf_refresh=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("clears local cookies but reports unconfirmed revocation when Supabase sign-out fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth/v1/user") && init?.method === "GET") {
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          user_metadata: { display_name: "Creator" },
        });
      }
      if (url.pathname.endsWith("/auth/v1/logout") && init?.method === "POST") {
        return Response.json({ message: "temporary upstream failure" }, { status: 503 });
      }
      throw new Error("Unexpected Supabase auth request: " + url.pathname);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleAuthApiRequest(
      logoutRequest({ origin: "https://codeforge.example", cookie: "cf_access=test-access; cf_refresh=test-refresh" }),
      runtimeEnv,
    );
    const payload = await response?.json();
    const setCookie = response?.headers.get("set-cookie") || "";

    expect(response?.status).toBe(502);
    expect(payload).toMatchObject({ error: "LOGOUT_REVOCATION_UNCONFIRMED" });
    expect(setCookie).toContain("cf_access=");
    expect(setCookie).toContain("cf_refresh=");
    expect(setCookie).toContain("Max-Age=0");
  });
});


describe("authentication session recovery during upstream failures", () => {
  it("preserves refresh cookies when Supabase Auth returns a transient error", async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { message: "temporarily unavailable" },
      { status: 503 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const session = await getAuthenticatedSession(
      new Request("https://codeforge.example/api/auth/me", {
        headers: { cookie: "cf_access=existing-access-token; cf_refresh=existing-refresh-token" },
      }),
      runtimeEnv,
    );

    expect(session.user).toBeNull();
    expect(session.unavailable).toBe(true);
    expect(session.cookies).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not clear refresh cookies when a network error prevents verification", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ message: "expired access token" }, { status: 401 }))
      .mockRejectedValueOnce(new Error("connection timed out"));
    vi.stubGlobal("fetch", fetchMock);

    const session = await getAuthenticatedSession(
      new Request("https://codeforge.example/api/auth/me", {
        headers: { cookie: "cf_access=expired-access-token; cf_refresh=possibly-valid-refresh-token" },
      }),
      runtimeEnv,
    );

    expect(session.unavailable).toBe(true);
    expect(session.cookies).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears cookies when Supabase definitively rejects the refresh token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ message: "expired access token" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ message: "invalid refresh token" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const session = await getAuthenticatedSession(
      new Request("https://codeforge.example/api/auth/me", {
        headers: { cookie: "cf_access=expired-access-token; cf_refresh=invalid-refresh-token" },
      }),
      runtimeEnv,
    );

    expect(session.user).toBeNull();
    expect(session.unavailable).toBeUndefined();
    expect(session.cookies).toHaveLength(2);
    expect(session.cookies.every(value => value.includes("Max-Age=0"))).toBe(true);
  });

  it("returns a recoverable service error from /me instead of reporting signed out", async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { message: "temporarily unavailable" },
      { status: 503 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleAuthApiRequest(
      new Request("https://codeforge.example/api/auth/me", {
        headers: { cookie: "cf_access=existing-access-token; cf_refresh=existing-refresh-token" },
      }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(503);
    expect(payload).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    expect(response?.headers.get("set-cookie") ?? "").toBe("");
  });
});

describe("authentication endpoints classify upstream outages correctly", () => {
  it.each(["/api/auth/login", "/api/auth/signup"])(
    "returns AUTH_UNAVAILABLE when Supabase is temporarily down during %s",
    async path => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "temporarily unavailable" }, { status: 503 })));
      const body = path.endsWith("/signup")
        ? { email: "creator@example.com", password: "secure-password", displayName: "Creator" }
        : { email: "creator@example.com", password: "secure-password" };
      const response = await handleAuthApiRequest(authPost(path, body), runtimeEnv);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    },
  );

  it("keeps definitive invalid access-token responses distinct", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "invalid token" }, { status: 401 })));
    const response = await handleAuthApiRequest(authPost("/api/auth/session", {
      accessToken: "a-valid-looking-access-token-value", refreshToken: "a-valid-looking-refresh-token",
    }), runtimeEnv);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ error: "INVALID_SESSION" });
  });

  it("returns AUTH_UNAVAILABLE for access-token verification 503s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "temporarily unavailable" }, { status: 503 })));
    const response = await handleAuthApiRequest(authPost("/api/auth/session", {
      accessToken: "a-valid-looking-access-token-value", refreshToken: "a-valid-looking-refresh-token",
    }), runtimeEnv);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
  });

  it("returns AUTH_UNAVAILABLE for password-reset token verification 503s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "temporarily unavailable" }, { status: 503 })));
    const response = await handleAuthApiRequest(authPost("/api/auth/recovery-session", {
      accessToken: "a-valid-looking-access-token-value", refreshToken: "a-valid-looking-refresh-token",
    }), runtimeEnv);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
  });

  it("returns AUTH_UNAVAILABLE when password-reset email service is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "temporarily unavailable" }, { status: 503 })));
    const response = await handleAuthApiRequest(authPost("/api/auth/recover", { email: "creator@example.com" }), runtimeEnv);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
  });

  it("keeps Supabase rate limiting distinct during login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "slow down" }, { status: 429 })));
    const response = await handleAuthApiRequest(authPost("/api/auth/login", {
      email: "creator@example.com", password: "secure-password",
    }), runtimeEnv);
    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({ error: "RATE_LIMITED" });
  });
});
