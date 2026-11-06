import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChatApiRequest } from "../lib/chat-api.server";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const USER_ACCESS_TOKEN = "supabase-user-access-token-for-private-gateway";
const authEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_ANON_KEY: "publishable-test-key",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function chatRequest(signedIn: boolean) {
  return new Request("https://codeforge.example/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://codeforge.example",
      "x-real-ip": "198.51.100.230",
      ...(signedIn ? { cookie: "cf_access=" + USER_ACCESS_TOKEN } : {}),
    },
    body: JSON.stringify({
      provider: "smart",
      voiceMode: true,
      messages: [{ role: "user", content: "Reply with a short greeting." }],
    }),
  });
}

function completedSse(text: string) {
  return [
    "data: " + JSON.stringify({
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }),
    "data: " + JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    "data: [DONE]",
    "",
  ].join("\n\n");
}

async function readEvents(response: Response) {
  const raw = await response.text();
  return raw.split(/\r?\n\r?\n/).filter(Boolean).flatMap(frame => {
    const data = frame.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data) as Record<string, unknown>]; }
    catch { return []; }
  });
}

function authResponse(url: string, init?: RequestInit) {
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
  return Response.json({
    id: USER_ID,
    email: "tester@example.com",
    user_metadata: { display_name: "Alpha Tester" },
  });
}

describe("Tatv Smart private gateway routing", () => {
  it("fails over between two private gateway instances using only the signed-in user's JWT", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);

      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, headers, body });

      if (url === "https://primary-gateway.example/v1/chat/completions") {
        expect(headers.get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
        return Response.json(
          { error: { code: "UPSTREAM_UNAVAILABLE", message: "Primary gateway is temporarily unavailable." } },
          { status: 503 },
        );
      }
      if (url === "https://backup-gateway.example/v1/chat/completions") {
        expect(headers.get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
        return new Response(completedSse("Private backup gateway answered."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_MODEL: "auto:fast",
      // These legacy public single-user values must not be used by Smart,
      // even if they accidentally remain in an old deployment environment.
      FREELLMAPI_BASE_URL: "https://public-single-user.example/v1",
      FREELLMAPI_API_KEY: "public-single-user-test-key",
      FREELLMAPI_MODEL: "auto:smart",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEvents(response!);

    expect(calls.map(call => call.url)).toEqual([
      "https://primary-gateway.example/v1/chat/completions",
      "https://backup-gateway.example/v1/chat/completions",
    ]);
    expect(calls[0]?.body["model"]).toBe("auto");
    expect(calls[1]?.body["model"]).toBe("auto:fast");

    expect(events.some(event => event["text"] === "Private backup gateway answered.")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(USER_ACCESS_TOKEN);
    expect(JSON.stringify(events)).not.toContain("public-single-user-test-key");
  });

  it("fails over after a private gateway connection error before answer text", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
      calls.push(url);

      if (url === "https://primary-gateway.example/v1/chat/completions") {
        throw new TypeError("simulated network connection failure");
      }
      if (url === "https://backup-gateway.example/v1/chat/completions") {
        return new Response(completedSse("The backup answered after a connection failure."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-gateway.example",
    });

    expect(response).not.toBeNull();
    const events = await readEvents(response!);
    expect(calls).toEqual([
      "https://primary-gateway.example/v1/chat/completions",
      "https://backup-gateway.example/v1/chat/completions",
    ]);
    expect(events.some(event => event["text"] === "The backup answered after a connection failure.")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(USER_ACCESS_TOKEN);
  });

  it("does not bypass a private gateway provider rate limit with another gateway", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);
      calls.push(url);
      if (url === "https://primary-gateway.example/v1/chat/completions") {
        return Response.json(
          { error: { code: "UPSTREAM_RATE_LIMITED", message: "Provider quota reached." } },
          { status: 429, headers: { "retry-after": "60" } },
        );
      }
      if (url === "https://backup-gateway.example/v1/chat/completions") {
        return new Response(completedSse("This backup must not be used to bypass a quota."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-gateway.example",
    });

    expect(response).not.toBeNull();
    const events = await readEvents(response!);
    expect(calls).toEqual(["https://primary-gateway.example/v1/chat/completions"]);
    expect(events.some(event => event["code"] === "UPSTREAM_RATE_LIMITED")).toBe(true);
    expect(events.some(event => event["text"] === "This backup must not be used to bypass a quota.")).toBe(false);
  });

  it("uses the private primary gateway when no backup URL is configured", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url === "https://primary-gateway.example/v1/chat/completions") {
        return new Response(completedSse("Private primary gateway answered."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(calls).toEqual([{
      url: "https://primary-gateway.example/v1/chat/completions",
      authorization: "Bearer " + USER_ACCESS_TOKEN,
    }]);
    const events = await readEvents(response!);
    expect(events.some(event => event["text"] === "Private primary gateway answered.")).toBe(true);
  });

  it("can use the independent private fallback as the only configured endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);
      expect(url).toBe("https://backup-gateway.example/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
      return new Response(completedSse("Fallback-only route answered."), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-gateway.example",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEvents(response!);
    expect(events.some(event => event["text"] === "Fallback-only route answered.")).toBe(true);
  });

  it("tries all configured private gateways when an earlier gateway has no enabled model", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);

      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
      calls.push(url);

      if (url === "https://primary-gateway.example/v1/chat/completions" ||
          url === "https://secondary-gateway.example/v1/chat/completions") {
        return Response.json({
          error: {
            code: "NO_PROVIDER_MODEL",
            message: "No enabled chat model exists in this gateway.",
          },
        }, { status: 503 });
      }
      if (url === "https://tertiary-gateway.example/v1/chat/completions") {
        return Response.json({
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "This gateway is temporarily unavailable.",
          },
        }, { status: 503 });
      }
      if (url === "https://quaternary-gateway.example/v1/chat/completions") {
        return new Response(completedSse("The fourth private gateway answered."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://secondary-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_MODEL: "auto:fast",
      CODEFORGE_GATEWAY_FALLBACK_2_URL: "https://tertiary-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_2_MODEL: "auto:balanced",
      CODEFORGE_GATEWAY_FALLBACK_3_URL: "https://quaternary-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_3_MODEL: "auto:smart",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEvents(response!);

    expect(calls).toEqual([
      "https://primary-gateway.example/v1/chat/completions",
      "https://secondary-gateway.example/v1/chat/completions",
      "https://tertiary-gateway.example/v1/chat/completions",
      "https://quaternary-gateway.example/v1/chat/completions",
    ]);
    expect(events.some(event => event["text"] === "The fourth private gateway answered.")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(USER_ACCESS_TOKEN);
  });

  it("recognizes gateway-specific empty-catalog errors from the fourth private endpoint", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);

      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
      calls.push(url);

      if (url === "https://primary-gateway.example/v1/chat/completions" ||
          url === "https://secondary-gateway.example/v1/chat/completions" ||
          url === "https://tertiary-gateway.example/v1/chat/completions") {
        return Response.json({
          error: { code: "NO_PROVIDER_MODEL", message: "No enabled chat model exists." },
        }, { status: 503 });
      }
      if (url === "https://quaternary-gateway.example/v1/chat/completions") {
        return Response.json({
          error: { code: "NO_PROVIDER_MODEL", message: "No enabled chat model exists in the fourth gateway." },
        }, { status: 503 });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://secondary-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_2_URL: "https://tertiary-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_3_URL: "https://quaternary-gateway.example",
    });

    expect(response).not.toBeNull();
    const events = await readEvents(response!);
    expect(calls).toEqual([
      "https://primary-gateway.example/v1/chat/completions",
      "https://secondary-gateway.example/v1/chat/completions",
      "https://tertiary-gateway.example/v1/chat/completions",
      "https://quaternary-gateway.example/v1/chat/completions",
    ]);
    expect(events[events.length - 1]).toMatchObject({
      code: "NO_PROVIDER_MODEL",
      error: expect.stringContaining("no eligible chat model is enabled"),
      done: true,
    });
    expect(JSON.stringify(events)).not.toContain("fourth gateway");
  });

  it("reports an empty private gateway model catalog instead of calling it an upstream overload", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(url, init);
      expect(url).toBe("https://primary-gateway.example/v1/chat/completions");
      return Response.json({
        error: {
          code: "NO_PROVIDER_MODEL",
          message: "No enabled chat model exists in the local catalog.",
        },
      }, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(true), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEvents(response!);
    const failure = events.find(event => typeof event["error"] === "string");
    expect(failure?.["code"]).toBe("NO_PROVIDER_MODEL");
    expect(failure?.["error"]).toContain("no enabled chat model");
    expect(failure?.["error"]).not.toContain("overloaded");
  });

  it("never sends guest traffic to a private gateway or forwards an administrator credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(false), {
      ...authEnv,
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-gateway.example",
      CODEFORGE_GATEWAY_ADMIN_TOKEN: "must-never-be-forwarded",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(await response!.json()).toMatchObject({ error: "SIGN_IN_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
