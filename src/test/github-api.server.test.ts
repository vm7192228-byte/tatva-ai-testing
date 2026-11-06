import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { handleGitHubApiRequest } from "@/lib/github-api.server";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_ANON_KEY: "test-anon-key",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  GITHUB_TOKEN_SECRET: "test-only-encryption-secret-with-enough-entropy",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function authCookie(userId: string): string {
  return "cf_access=access-" + userId;
}

function readCookie(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp("(?:^|,\\s*)" + name + "=([^;]+)"));
  if (!match?.[1]) throw new Error("Missing " + name + " cookie");
  return match[1];
}

function installFetch(userId: string, githubHandler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("crypto", webcrypto);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://supabase.example/auth/v1/user")) {
      return Response.json({ id: userId, email: userId + "@example.test", user_metadata: { full_name: "Test User" } });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_test_token_123456789", token_type: "bearer", scope: "repo read:user user:email" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "test-github-user", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "Test GitHub User" });
    }
    if (githubHandler) return await githubHandler(url, init);
    throw new Error("Unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function connectGitHub(userId: string): Promise<string> {
  const fetchMock = installFetch(userId);
  const connect = await handleGitHubApiRequest(
    new Request("https://app.example.test/api/github/connect", { headers: { cookie: authCookie(userId) } }),
    runtimeEnv,
  );
  expect(connect?.status).toBe(302);
  const location = connect?.headers.get("location");
  expect(location).toContain("https://github.com/login/oauth/authorize");
  const state = new URL(location!).searchParams.get("state");
  expect(state).toBeTruthy();
  const stateCookie = readCookie(connect?.headers.get("set-cookie") ?? null, "cf_github_state");

  const callback = await handleGitHubApiRequest(
    new Request("https://app.example.test/api/github/callback?code=test-code&state=" + encodeURIComponent(state!), {
      headers: { cookie: authCookie(userId) + "; cf_github_state=" + stateCookie },
    }),
    runtimeEnv,
  );
  expect(callback?.status).toBe(302);
  expect(callback?.headers.get("location")).toBe("/?github=connected");
  expect(fetchMock).toHaveBeenCalledWith("https://github.com/login/oauth/access_token", expect.any(Object));
  return readCookie(callback?.headers.get("set-cookie") ?? null, "cf_github_token");
}

describe("GitHub OAuth and repository API security", () => {
  it("requires a signed-in Tatv account before starting OAuth", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));

    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/connect"),
      runtimeEnv,
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ error: "AUTH_REQUIRED" });
  });

  it("recognizes the legacy Vercel GitHub client-secret key without exposing its value", async () => {
    installFetch("user-a");
    const legacyEnv = { ...runtimeEnv, GITHUB_CLIENT_SECRET: undefined, GITHUB_ClIENT_SECRET: "legacy-secret-value" };
    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/status", { headers: { cookie: authCookie("user-a") } }),
      legacyEnv,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ configured: true, connected: false });
  });

  it("binds the OAuth state to the Tatv account that started the flow", async () => {
    let currentUserId = "user-a";
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://supabase.example/auth/v1/user")) {
        return Response.json({ id: currentUserId, email: currentUserId + "@example.test", user_metadata: {} });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "gho_test_token_123456789", token_type: "bearer", scope: "repo read:user user:email" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ login: "test-github-user", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "Test GitHub User" });
      }
      throw new Error("Unexpected fetch: " + url);
    }));
    const connect = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/connect", { headers: { cookie: authCookie("user-a") } }),
      runtimeEnv,
    );
    const state = new URL(connect!.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = readCookie(connect!.headers.get("set-cookie"), "cf_github_state");
    currentUserId = "user-b";

    const callback = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/callback?code=test-code&state=" + encodeURIComponent(state), {
        headers: { cookie: authCookie("user-b") + "; cf_github_state=" + stateCookie },
      }),
      runtimeEnv,
    );

    expect(callback?.headers.get("location")).toBe("/?github=error");
  });

  it("does not let another Tatv account reuse the encrypted GitHub token", async () => {
    const tokenCookie = await connectGitHub("user-a");
    const fetchMock = installFetch("user-b");

    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/repos", {
        headers: { cookie: authCookie("user-b") + "; cf_github_token=" + tokenCookie },
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ error: "GITHUB_NOT_CONNECTED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses commits directly to the repository default branch", async () => {
    const tokenCookie = await connectGitHub("user-a");
    const fetchMock = installFetch("user-a", async (url, init) => {
      if (url === "https://api.github.com/repos/example/project") return Response.json({ default_branch: "main" });
      throw new Error("Unexpected GitHub request: " + url + " " + init?.method);
    });

    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/commit", {
        method: "POST",
        headers: { cookie: authCookie("user-a") + "; cf_github_token=" + tokenCookie, origin: "https://app.example.test", "content-type": "application/json" },
        body: JSON.stringify({ repo: "example/project", branch: "main", path: "README.md", content: "changed", message: "Update readme", expectedSha: "old-sha" }),
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ error: "DEFAULT_BRANCH_PROTECTED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a commit when the file changed since it was loaded", async () => {
    const tokenCookie = await connectGitHub("user-a");
    const fetchMock = installFetch("user-a", async (url, init) => {
      if (url === "https://api.github.com/repos/example/project") return Response.json({ default_branch: "main" });
      if (url === "https://api.github.com/repos/example/project/branches/feature%2Fwork") return Response.json({ commit: { sha: "branch-sha" } });
      if (url === "https://api.github.com/repos/example/project/contents/README.md?ref=feature%2Fwork") return Response.json({ sha: "new-sha", type: "file" });
      throw new Error("Unexpected GitHub request: " + url + " " + init?.method);
    });

    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/commit", {
        method: "POST",
        headers: { cookie: authCookie("user-a") + "; cf_github_token=" + tokenCookie, origin: "https://app.example.test", "content-type": "application/json" },
        body: JSON.stringify({ repo: "example/project", branch: "feature/work", path: "README.md", content: "changed", message: "Update readme", expectedSha: "old-sha" }),
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ error: "FILE_CHANGED" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("requires the exact current pull-request head before merge", async () => {
    const tokenCookie = await connectGitHub("user-a");
    const currentSha = "a".repeat(40);
    const fetchMock = installFetch("user-a", async (url, init) => {
      if (url === "https://api.github.com/repos/example/project/pulls/7") {
        return Response.json({ state: "open", draft: false, mergeable: true, head: { sha: currentSha } });
      }
      throw new Error("Unexpected GitHub request: " + url + " " + init?.method);
    });

    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/merge", {
        method: "POST",
        headers: { cookie: authCookie("user-a") + "; cf_github_token=" + tokenCookie, origin: "https://app.example.test", "content-type": "application/json" },
        body: JSON.stringify({ repo: "example/project", number: 7, method: "squash", expectedHeadSha: "b".repeat(40) }),
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ error: "PULL_REQUEST_CHANGED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const tokenCookie = await connectGitHub("user-a");

    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test/api/github/disconnect", {
        method: "POST",
        headers: { cookie: authCookie("user-a") + "; cf_github_token=" + tokenCookie, origin: "https://attacker.example", "content-type": "application/json" },
        body: "{}",
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
  });
});


describe("GitHub routes preserve account state during Supabase Auth outages", () => {
  it.each([
    ["/api/github/status", "GET"],
    ["/api/github/connect", "GET"],
    ["/api/github/callback?code=one-time-code&state=one-time-state", "GET"],
    ["/api/github/disconnect", "POST"],
  ] as const)("returns AUTH_UNAVAILABLE for %s", async (path, method) => {
    const fetchMock = vi.fn(async () =>
      Response.json({ message: "temporarily unavailable" }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleGitHubApiRequest(
      new Request("https://app.example.test" + path, {
        method,
        headers: {
          cookie: "cf_access=existing-access-token; cf_github_state=user-a.one-time-state",
          ...(method === "POST" ? { origin: "https://app.example.test" } : {}),
        },
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
