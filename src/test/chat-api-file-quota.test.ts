import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));

import { handleChatApiRequest } from "../lib/chat-api.server";

const userId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const reservationIds = [
  "22222222-2222-4222-8222-222222222222",
  "44444444-4444-4444-8444-444444444444",
];

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
  CODEFORGE_GATEWAY_MODEL: "auto",
};

function session() {
  return {
    configured: true,
    user: { id: userId, email: "creator@example.com", displayName: "Creator", avatarUrl: "" },
    accessToken: "test-access-token",
    cookies: [],
  };
}

function requestWithFiles(count: number) {
  return new Request("https://codeforge.example/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://codeforge.example",
      cookie: "cf_access=valid-test-session",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      provider: "smart",
      messages: [{
        role: "user",
        content: "Please analyze these files.",
        attachments: Array.from({ length: count }, (_, index) => ({
          name: "file-" + index + ".txt",
          mimeType: "text/plain",
          size: 12,
          textContent: "File content " + index,
        })),
      }],
    }),
  });
}

function installFetch(options: {
  reservationResults: Array<Record<string, unknown> | Error>;
}) {
  const reservationKeys: string[] = [];
  const finalizationActions: string[] = [];
  const providerCalls: string[] = [];
  let reservationIndex = 0;
  const stream = [
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: "Files analyzed." }, finish_reason: null }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]",
  ].join("\n\n") + "\n\n";

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/rpc/cf_allow_transcription_attempt")) {
      return Response.json({ allowed: true, attempts: 1, retryAfterSeconds: 60 });
    }
    if (url.includes("/rest/v1/cf_subscriptions")) {
      return Response.json([]);
    }
    if (url.endsWith("/rpc/cf_reserve_usage_quota")) {
      const body = JSON.parse(String(init?.body)) as { p_idempotency_key: string };
      reservationKeys.push(body.p_idempotency_key);
      const result = options.reservationResults[reservationIndex++];
      if (result instanceof Error) throw result;
      return Response.json(result);
    }
    if (url.endsWith("/rpc/cf_finalize_usage_quota")) {
      const body = JSON.parse(String(init?.body)) as { p_action: string };
      finalizationActions.push(body.p_action);
      return Response.json({ ok: true, status: body.p_action === "commit" ? "committed" : "released" });
    }
    if (url.endsWith("/chat/completions")) {
      providerCalls.push(url);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    throw new Error("Unexpected test request: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { reservationKeys, finalizationActions, providerCalls, fetchMock };
}

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat file-analysis quota units", () => {
  it("reserves and commits one quota unit for each attached file", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(session());
    const { reservationKeys, finalizationActions, providerCalls } = installFetch({
      reservationResults: reservationIds.map((reservationId, index) => ({
        allowed: true,
        reservationId,
        planCode: "free",
        limit: 3,
        used: index + 1,
        remaining: 2 - index,
      })),
    });

    const response = await handleChatApiRequest(requestWithFiles(2), runtimeEnv);
    const output = await response!.text();

    expect(response?.status).toBe(200);
    expect(output).toContain("Files analyzed.");
    expect(reservationKeys).toHaveLength(2);
    expect(reservationKeys[0]).not.toBe(reservationKeys[1]);
    expect(finalizationActions).toEqual(["commit", "commit"]);
    expect(providerCalls).toHaveLength(1);
  });

  it("releases earlier file reservations when a later file exceeds the remaining allowance", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(session());
    const { finalizationActions, providerCalls } = installFetch({
      reservationResults: [
        { allowed: true, reservationId: reservationIds[0], planCode: "free", limit: 3, used: 3, remaining: 0 },
        { allowed: false, error: "MONTHLY_LIMIT_REACHED", planCode: "free", limit: 3, used: 3, remaining: 0 },
      ],
    });

    const response = await handleChatApiRequest(requestWithFiles(2), runtimeEnv);
    const payload = await response!.json();

    expect(response?.status).toBe(402);
    expect(payload.error).toBe("PLAN_LIMIT_REACHED");
    expect(payload.feature).toBe("file_analysis");
    expect(payload.used).toBe(2);
    expect(payload.remaining).toBe(1);
    expect(payload.requested).toBe(2);
    expect(finalizationActions).toEqual(["release"]);
    expect(providerCalls).toHaveLength(0);
  });

  it("releases partial reservations when a later quota RPC fails", async () => {
    vi.stubGlobal("crypto", webcrypto);
    mocks.getAuthenticatedSession.mockResolvedValue(session());
    const { finalizationActions, providerCalls } = installFetch({
      reservationResults: [
        { allowed: true, reservationId: reservationIds[0], planCode: "free", limit: 3, used: 1, remaining: 2 },
        new Error("temporary database failure"),
      ],
    });

    const response = await handleChatApiRequest(requestWithFiles(2), runtimeEnv);
    const payload = await response!.json();

    expect(response?.status).toBe(503);
    expect(payload.error).toBe("FILE_QUOTA_UNAVAILABLE");
    expect(finalizationActions).toEqual(["release"]);
    expect(providerCalls).toHaveLength(0);
  });
});
