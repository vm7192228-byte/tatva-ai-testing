import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChatApiRequest } from "@/lib/chat-api.server";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";
const TESTER_EMAIL = "tester@example.com";
const USER_ACCESS_TOKEN = "supabase-user-access-token";
const PERSONAL_API_KEY = "freellmapi-personal-unified-key";

const authEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_ANON_KEY: "publishable-test-key",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function chatRequest(ip = "198.51.100.230", chatMode = "smart") {
  return new Request("https://codeforge.example/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://codeforge.example",
      "x-real-ip": ip,
      cookie: "cf_access=" + USER_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      provider: "smart",
      chatMode,
      voiceMode: true,
      disableDurableWorkflow: true,
      messages: [{ role: "user", content: "Reply with a short greeting." }],
    }),
  });
}

function authResponse(init: RequestInit | undefined, email: string) {
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
  return Response.json({
    id: OWNER_ID,
    email,
    user_metadata: { display_name: "Signed-in user" },
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

function ownerRouteEnv() {
  return {
    ...authEnv,
    FREELLMAPI_OWNER_EMAIL: OWNER_EMAIL,
    FREELLMAPI_BASE_URL: "https://personal-freellmapi.example/v1",
    FREELLMAPI_API_KEY: PERSONAL_API_KEY,
    FREELLMAPI_MODEL: "auto:smart",
    CODEFORGE_GATEWAY_URL: "https://private-gateway.example",
    CODEFORGE_GATEWAY_MODEL: "auto",
  };
}

describe("owner-only FreeLLMAPI personal route", () => {
  it("keeps the personal endpoint out of shared provider discovery and never exposes its key", async () => {
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", { method: "GET" }),
      ownerRouteEnv(),
    );

    expect(response).not.toBeNull();
    const payload = await response!.json();
    expect(payload.providers.freellmapi).toBe(false);
    expect(payload.providers.codeforgeGateway).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(PERSONAL_API_KEY);
  });

  it("routes the verified owner to FreeLLMAPI first and keeps the personal key server-side", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, OWNER_EMAIL);

      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (url === "https://personal-freellmapi.example/v1/chat/completions") {
        return new Response(completedSse("Owner-only FreeLLMAPI answered."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest(), ownerRouteEnv());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEvents(response!);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://personal-freellmapi.example/v1/chat/completions",
      authorization: "Bearer " + PERSONAL_API_KEY,
      body: { model: "auto:smart", stream: true },
    });
    expect(events.some(event => event["text"] === "Owner-only FreeLLMAPI answered.")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(PERSONAL_API_KEY);
    expect(JSON.stringify(events)).not.toContain(USER_ACCESS_TOKEN);
  });

  it("switches to the private multi-user gateway only on FreeLLMAPI quota_exceeded", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, OWNER_EMAIL);

      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url === "https://personal-freellmapi.example/v1/chat/completions") {
        expect(authorization).toBe("Bearer " + PERSONAL_API_KEY);
        return Response.json(
          { error: { code: "quota_exceeded", message: "Monthly budget exhausted." } },
          { status: 429, headers: { "retry-after": "3600" } },
        );
      }
      if (url === "https://private-gateway.example/v1/chat/completions") {
        expect(authorization).toBe("Bearer " + USER_ACCESS_TOKEN);
        return new Response(completedSse("Private gateway backup answered."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest("198.51.100.231"), ownerRouteEnv());
    expect(response).not.toBeNull();
    const events = await readEvents(response!);

    expect(calls.map(call => call.url)).toEqual([
      "https://personal-freellmapi.example/v1/chat/completions",
      "https://private-gateway.example/v1/chat/completions",
    ]);
    expect(events.some(event => event["text"] === "Private gateway backup answered.")).toBe(true);
    expect(events.some(event => event["status"] === "retrying")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(PERSONAL_API_KEY);
    expect(JSON.stringify(events)).not.toContain(USER_ACCESS_TOKEN);
  });

  it("keeps tester traffic on the private multi-user gateway, never on the personal endpoint", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, TESTER_EMAIL);
      calls.push(url);
      if (url === "https://private-gateway.example/v1/chat/completions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
        expect(JSON.parse(String(init?.body)).chatMode).toBe("flash");
        return new Response(completedSse("Tester used the private gateway."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest("198.51.100.232", "flash"), ownerRouteEnv());
    expect(response).not.toBeNull();
    const events = await readEvents(response!);

    expect(calls).toEqual(["https://private-gateway.example/v1/chat/completions"]);
    expect(events.some(event => event["text"] === "Tester used the private gateway.")).toBe(true);
  });

  it("switches to the private gateway on an ordinary FreeLLMAPI rate limit too", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, OWNER_EMAIL);
      calls.push(url);
      if (url === "https://personal-freellmapi.example/v1/chat/completions") {
        return Response.json(
          { error: { code: "rate_limit_exceeded", message: "Short window rate limit." } },
          { status: 429 },
        );
      }
      if (url === "https://private-gateway.example/v1/chat/completions") {
        return new Response(completedSse("Backup answered after a rate limit."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest("198.51.100.233"), ownerRouteEnv());
    expect(response).not.toBeNull();
    const events = await readEvents(response!);

    expect(calls).toEqual([
      "https://personal-freellmapi.example/v1/chat/completions",
      "https://private-gateway.example/v1/chat/completions",
    ]);
    expect(events.some(event => event["text"] === "Backup answered after a rate limit.")).toBe(true);
    expect(events.some(event => event["code"] === "UPSTREAM_RATE_LIMITED")).toBe(false);
  });

  it("uses FreeLLMAPI first for every signed-in user when FREELLMAPI_SHARED_PRIMARY is enabled", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, TESTER_EMAIL);
      calls.push(url);
      if (url === "https://personal-freellmapi.example/v1/chat/completions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + PERSONAL_API_KEY);
        return new Response(completedSse("Shared primary FreeLLMAPI answered."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest("198.51.100.235"), {
      ...ownerRouteEnv(),
      FREELLMAPI_SHARED_PRIMARY: "true",
    });
    expect(response).not.toBeNull();
    const events = await readEvents(response!);

    expect(calls).toEqual(["https://personal-freellmapi.example/v1/chat/completions"]);
    expect(events.some(event => event["text"] === "Shared primary FreeLLMAPI answered.")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(PERSONAL_API_KEY);
  });

  it("keeps Tatv Flash on the private gateway even when shared FreeLLMAPI primary is enabled", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, TESTER_EMAIL);
      calls.push(url);
      if (url === "https://private-gateway.example/v1/chat/completions") {
        expect(JSON.parse(String(init?.body)).chatMode).toBe("flash");
        return new Response(completedSse("Flash stayed on the private gateway."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest("198.51.100.237", "flash"), {
      ...ownerRouteEnv(),
      FREELLMAPI_SHARED_PRIMARY: "true",
    });
    expect(response).not.toBeNull();
    const events = await readEvents(response!);
    expect(calls).toEqual(["https://private-gateway.example/v1/chat/completions"]);
    expect(events.some(event => event["text"] === "Flash stayed on the private gateway.")).toBe(true);
  });

  it("falls back to the private gateway for any user when shared FreeLLMAPI quota runs out", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/auth/v1/user") return authResponse(init, TESTER_EMAIL);
      calls.push(url);
      if (url === "https://personal-freellmapi.example/v1/chat/completions") {
        return Response.json({ error: { code: "quota_exceeded" } }, { status: 429 });
      }
      if (url === "https://private-gateway.example/v1/chat/completions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + USER_ACCESS_TOKEN);
        return new Response(completedSse("Gateway took over for the tester."), {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      throw new Error("Unexpected upstream URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(chatRequest("198.51.100.236"), {
      ...ownerRouteEnv(),
      FREELLMAPI_SHARED_PRIMARY: "true",
    });
    expect(response).not.toBeNull();
    const events = await readEvents(response!);

    expect(calls).toEqual([
      "https://personal-freellmapi.example/v1/chat/completions",
      "https://private-gateway.example/v1/chat/completions",
    ]);
    expect(events.some(event => event["text"] === "Gateway took over for the tester.")).toBe(true);
  });

  it("does not allow a client to select the legacy personal route directly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://codeforge.example",
          "x-real-ip": "198.51.100.234",
        },
        body: JSON.stringify({
          provider: "freellmapi",
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      ownerRouteEnv(),
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(410);
    expect(await response!.json()).toMatchObject({ error: "PUBLIC_GATEWAY_NOT_AVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
