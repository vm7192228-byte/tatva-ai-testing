import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const authMocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => authMocks);

import {
  claimChatGenerationForProvider,
  getOwnedChatGeneration,
  getSavedTextMessagesForGeneration,
  handleChatGenerationsApiRequest,
  persistChatGenerationStream,
} from "../lib/chat-generations.server";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const generationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-service-key",
};

function createProviderStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function createRpcFetchMock() {
  let sequence = 0;
  const appended: Array<Record<string, unknown>> = [];
  let finished: Record<string, unknown> | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/rpc/cf_append_chat_generation_event")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      appended.push(body);
      sequence += 1;
      return new Response(JSON.stringify({ ok: true, seq: sequence }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/rpc/cf_finish_chat_generation")) {
      finished = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, status: finished["p_status"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Unexpected test request", { status: 404 });
  });
  return { fetchMock, appended, get finished() { return finished; } };
}

afterEach(() => {
  authMocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saved chat input for durable workflows", () => {
  const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("loads only owner-scoped text messages using the server-only database key", async () => {
    const savedMessages = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Continue the conversation" },
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify([{ id: conversationId, messages: savedMessages }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages = await getSavedTextMessagesForGeneration(runtimeEnv, userId, conversationId);
    const call = fetchMock.mock.calls[0];
    expect(messages).toEqual(savedMessages);
    expect(String(call?.[0])).toContain("/rest/v1/conversations");
    expect(String(call?.[0])).toContain("id=eq." + conversationId);
    expect(String(call?.[0])).toContain("user_id=eq." + userId);
    expect(String(call?.[0])).toContain("select=id,messages");
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe("Bearer server-only-service-key");
  });

  it("rejects saved messages that contain attachment payloads", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify([{
        id: conversationId,
        messages: [{ role: "user", content: "Please inspect this file", attachments: [{ name: "private.txt", data: "payload" }] }],
      }]), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSavedTextMessagesForGeneration(runtimeEnv, userId, conversationId))
      .rejects.toThrow("GENERATION_CONVERSATION_INVALID");
  });

  it("rejects conversation rows that are not owned by the requested user", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify([{
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        messages: [{ role: "user", content: "A prompt" }],
      }]), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSavedTextMessagesForGeneration(runtimeEnv, userId, conversationId))
      .rejects.toThrow("GENERATION_CONVERSATION_NOT_FOUND");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("user_id=eq." + userId);
  });
});


describe("durable chat generation migration source", () => {
  it("uses a valid matching dollar-quote delimiter for cf_claim_chat_generation", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261102143000_durable_chat_generation_events.sql"),
      "utf8",
    );
    const start = sql.indexOf("create or replace function public.cf_claim_chat_generation");
    const end = sql.indexOf("create or replace function public.cf_append_chat_generation_event", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const claimFunction = sql.slice(start, end);
    expect(claimFunction).toContain("\nas $function$\n");
    expect(claimFunction).toContain("\n$function$;\n");
    expect(claimFunction).not.toMatch(/\nas \$(?:\s|\n)/);
  });
});

describe("durable chat generation origin protection", () => {
  it("rejects generation-start POSTs without a verifiable same-origin signal", async () => {
    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", provider: "smart" }),
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
    expect(authMocks.getAuthenticatedSession).not.toHaveBeenCalled();
  });

  it("rejects cross-origin generation-start POSTs", async () => {
    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", provider: "smart" }),
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(403);
    expect(authMocks.getAuthenticatedSession).not.toHaveBeenCalled();
  });
});

describe("durable chat generation event persistence", () => {
  it("awaits failure finalization when the provider returns a non-stream response", async () => {
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => await new Promise<Response>(resolve => {
      releaseFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const pendingResponse = persistChatGenerationStream(
      new Response(JSON.stringify({ error: "PROVIDER_UNAVAILABLE" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
      runtimeEnv,
      userId,
      generationId,
      new AbortController(),
    ).then(response => {
      settled = true;
      return response;
    });

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(releaseFetch).toBeTypeOf("function");

    releaseFetch?.(Response.json({ ok: true, status: "failed" }));
    const response = await pendingResponse;

    expect(response.status).toBe(502);
    expect(settled).toBe(true);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toContain("/rpc/cf_finish_chat_generation");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      p_status: "failed",
      p_status_message: "The provider did not start a stream.",
    });
  });

  it("persists ordered events before forwarding them and commits a completed stream", async () => {
    const mock = createRpcFetchMock();
    vi.stubGlobal("fetch", mock.fetchMock);

    let backgroundTask: Promise<unknown> | undefined;
    const response = await persistChatGenerationStream(
      createProviderStream([
        'data: {"text":"A durable " }\n\n',
        'data: {"text":"chat answer."}\n\n',
        'data: {"done":true,"model":"test-model"}\n\n',
      ]),
      runtimeEnv,
      userId,
      generationId,
      new AbortController(),
      { waitUntil: (task: Promise<unknown>) => { backgroundTask = task; } },
    );

    const output = await response.text();
    await backgroundTask;

    expect(output).toContain("id: 1\ndata: {\"text\":\"A durable \"}");
    expect(output).toContain("id: 2\ndata: {\"text\":\"chat answer.\"}");
    expect(output).toContain("id: 3\ndata: {\"done\":true,\"model\":\"test-model\"}");
    expect(mock.appended).toHaveLength(3);
    expect(mock.appended.map(item => item["p_payload"])).toEqual([
      { text: "A durable " },
      { text: "chat answer." },
      { done: true, model: "test-model" },
    ]);
    expect(mock.appended.every(item =>
      item["p_user_id"] === userId && item["p_generation_id"] === generationId
    )).toBe(true);
    expect(mock.finished).toMatchObject({
      p_user_id: userId,
      p_generation_id: generationId,
      p_status: "completed",
    });
  });

  it("continues persisting events after the browser cancels its response reader", async () => {
    const mock = createRpcFetchMock();
    vi.stubGlobal("fetch", mock.fetchMock);

    let backgroundTask: Promise<unknown> | undefined;
    const response = await persistChatGenerationStream(
      createProviderStream([
        'data: {"text":"Saved even after disconnect."}\n\n',
        'data: {"done":true}\n\n',
      ]),
      runtimeEnv,
      userId,
      generationId,
      new AbortController(),
      { waitUntil: (task: Promise<unknown>) => { backgroundTask = task; } },
    );

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.cancel("simulated browser disconnect");
    await backgroundTask;

    expect(mock.appended).toHaveLength(2);
    expect(mock.appended.map(item => item["p_payload"])).toEqual([
      { text: "Saved even after disconnect." },
      { done: true },
    ]);
    expect(mock.finished).toMatchObject({ p_status: "completed" });
  });

  it("aborts an active provider stream when its durable generation expires", async () => {
    const generationAbort = new AbortController();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/cf_chat_generations")) {
        return Response.json([{
          id: generationId,
          user_id: userId,
          conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          provider: "smart",
          status: "running",
          last_event_seq: 1,
          expires_at: "2020-01-01T00:00:00.000Z",
        }]);
      }
      if (url.endsWith("/rpc/cf_append_chat_generation_event")) {
        return Response.json({ ok: false, error: "GENERATION_NOT_RUNNING" });
      }
      if (url.endsWith("/rpc/cf_finish_chat_generation")) {
        return Response.json({ ok: true, status: "expired" });
      }
      return new Response("Unexpected test request", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    let backgroundTask: Promise<unknown> | undefined;
    let upstreamCancelled = false;
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start() {
        // Simulate a provider stream that stays open and never emits another frame.
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    const response = await persistChatGenerationStream(
      upstream,
      runtimeEnv,
      userId,
      generationId,
      generationAbort,
      { waitUntil: (task: Promise<unknown>) => { backgroundTask = task; } },
    );

    const outputPromise = response.text();
    await new Promise(resolve => setTimeout(resolve, 1_600));
    await backgroundTask;
    await outputPromise;

    expect(generationAbort.signal.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
    const recordedCalls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    const finishCall = recordedCalls.find(([input]) =>
      String(input).endsWith("/rpc/cf_finish_chat_generation")
    );
    expect(finishCall).toBeDefined();
    expect(JSON.parse(String(finishCall?.[1]?.body))).toMatchObject({
      p_user_id: userId,
      p_generation_id: generationId,
      p_status: "expired",
      p_status_message: "This generation expired before it could finish.",
    });
  });

  it("marks an expired generation terminal when its owner tries to read it", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: generationId,
        user_id: userId,
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        provider: "smart",
        status: "running",
        last_event_seq: 0,
        expires_at: "2026-11-01T00:00:00.000Z",
      }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "expired" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations/" + generationId, { method: "GET" }),
      runtimeEnv,
    );
    const payload = await response?.json() as { generation?: { status?: string } };
    const finishCall = fetchMock.mock.calls[1] as [string, RequestInit];

    expect(response?.status).toBe(200);
    expect(payload.generation?.status).toBe("expired");
    expect(String(finishCall[0])).toContain("/rpc/cf_finish_chat_generation");
    expect(JSON.parse(String(finishCall[1].body))).toMatchObject({
      p_user_id: userId,
      p_generation_id: generationId,
      p_status: "expired",
    });
  });

  it("does not create a durable generation for a conversation the user does not own", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations", {
        method: "POST",
        headers: {
          origin: "https://codeforge.example",
          "content-type": "application/json",
          "idempotency-key": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
        body: JSON.stringify({ conversationId, provider: "smart" }),
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { error?: string };
    const conversationLookup = String(fetchMock.mock.calls[0]?.[0]);

    expect(response?.status).toBe(404);
    expect(payload.error).toBe("CONVERSATION_NOT_FOUND");
    expect(conversationLookup).toContain("user_id=eq." + userId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(conversationLookup).not.toContain("rpc/cf_create_chat_generation");
  });

  it("finalizes a remote cancellation as cancelled instead of a persistence failure", async () => {
    const generationAbort = new AbortController();
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        generationAbort.signal.addEventListener("abort", () => {
          controller.error(new Error("Provider stream aborted by remote cancellation."));
        }, { once: true });
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: generationId,
        user_id: userId,
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        provider: "smart",
        status: "cancel_requested",
        last_event_seq: 2,
        expires_at: "2099-01-01T00:00:00.000Z",
      }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "cancelled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    let backgroundTask: Promise<unknown> | undefined;
    const response = await persistChatGenerationStream(
      upstream,
      runtimeEnv,
      userId,
      generationId,
      generationAbort,
      { waitUntil: (task: Promise<unknown>) => { backgroundTask = task; } },
    );
    const output = await response.text();
    await backgroundTask;

    expect(generationAbort.signal.aborted).toBe(true);
    expect(output).toContain("GENERATION_CANCELLED");
    expect(output).toContain('"cancelled":true');
    expect(output).not.toContain("GENERATION_PERSIST_FAILED");
    const finishCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(finishCall[0])).toContain("/rpc/cf_finish_chat_generation");
    expect(JSON.parse(String(finishCall[1].body))).toMatchObject({
      p_user_id: userId,
      p_generation_id: generationId,
      p_status: "cancelled",
    });
  });

  it("requires a signed-in owner before reading generation state", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      accessToken: undefined,
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations/" + generationId, { method: "GET" }),
      runtimeEnv,
    );
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(401);
    expect(payload.error).toBe("AUTH_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests cancellation only for the authenticated generation owner", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: generationId,
        user_id: userId,
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        provider: "smart",
        status: "running",
        last_event_seq: 1,
        expires_at: "2099-01-01T00:00:00.000Z",
      }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "cancelled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "cancelled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations/" + generationId + "/cancel", {
        method: "POST",
        headers: { origin: "https://codeforge.example", "content-type": "application/json" },
        body: "{}",
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { status?: string };
    const cancelCall = fetchMock.mock.calls[1] as [string, RequestInit];

    expect(response?.status).toBe(200);
    expect(payload.status).toBe("cancelled");
    expect(String(cancelCall[0])).toContain("/rpc/cf_request_chat_generation_cancel");
    expect(JSON.parse(String(cancelCall[1].body))).toEqual({
      p_user_id: userId,
      p_generation_id: generationId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the already-completed state when Stop races a finished response", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: generationId,
        user_id: userId,
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        provider: "smart",
        status: "completed",
        last_event_seq: 4,
        expires_at: "2026-11-04T00:00:00.000Z",
      }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "completed", alreadyFinished: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations/" + generationId + "/cancel", {
        method: "POST",
        headers: { origin: "https://codeforge.example", "content-type": "application/json" },
        body: "{}",
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { status?: string };

    expect(response?.status).toBe(200);
    expect(payload.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an idempotency key that resolves to another conversation or provider", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: conversationId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        generationId,
        status: "running",
        lastEventSeq: 1,
        conversationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        provider: "smart",
        existing: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations", {
        method: "POST",
        headers: {
          origin: "https://codeforge.example",
          "content-type": "application/json",
          "idempotency-key": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
        body: JSON.stringify({ conversationId, provider: "smart" }),
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(409);
    expect(payload.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps the per-user generation burst cap to HTTP 429", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: conversationId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "RATE_LIMITED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations", {
        method: "POST",
        headers: {
          origin: "https://codeforge.example",
          "content-type": "application/json",
          "idempotency-key": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
        body: JSON.stringify({ conversationId, provider: "smart" }),
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(429);
    expect(payload.error).toBe("GENERATION_RATE_LIMITED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps the active-generation cap to HTTP 429", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: conversationId }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "TOO_MANY_ACTIVE_GENERATIONS" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations", {
        method: "POST",
        headers: {
          origin: "https://codeforge.example",
          "content-type": "application/json",
          "idempotency-key": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
        body: JSON.stringify({ conversationId, provider: "smart" }),
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { error?: string };

    expect(response?.status).toBe(429);
    expect(payload.error).toBe("ACTIVE_GENERATION_LIMIT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not replay an older generation for a newer saved user turn", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      accessToken: "user-access-token",
      cookies: [],
    });
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: conversationId,
        updated_at: "2026-11-02T13:30:00.000Z",
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: generationId,
        user_id: userId,
        conversation_id: conversationId,
        idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        provider: "smart",
        status: "completed",
        last_event_seq: 9,
        created_at: "2026-11-02T13:29:59.900Z",
        expires_at: "2026-11-04T00:00:00.000Z",
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatGenerationsApiRequest(
      new Request("https://codeforge.example/api/chat/generations?conversationId=" + conversationId, {
        method: "GET",
      }),
      runtimeEnv,
    );
    const payload = await response?.json() as { generation?: unknown };

    expect(response?.status).toBe(200);
    expect(payload.generation).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("user_id=eq." + userId);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("user_id=eq." + userId);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("created_at.desc");
  });

  it("claims a durable generation exactly once before the provider request", async () => {
    const conversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      claimed: true,
      status: "running",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const claimed = await claimChatGenerationForProvider(
      runtimeEnv,
      userId,
      generationId,
      conversationId,
      idempotencyKey,
      "smart",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(claimed).toBe(true);
    expect(String(url)).toContain("/rpc/cf_claim_chat_generation");
    expect(JSON.parse(String(init.body))).toEqual({
      p_user_id: userId,
      p_generation_id: generationId,
      p_conversation_id: conversationId,
      p_idempotency_key: idempotencyKey,
      p_provider: "smart",
    });
  });

  it("rejects a replay after another request has claimed the provider boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "GENERATION_ALREADY_STARTED",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const claimed = await claimChatGenerationForProvider(
      runtimeEnv,
      userId,
      generationId,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "smart",
    );

    expect(claimed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scopes generation lookup to the authenticated owner in the database query", async () => {
    const record = {
      id: generationId,
      user_id: userId,
      conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      provider: "smart",
      status: "running",
      last_event_seq: 0,
      expires_at: "2026-11-04T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([record]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOwnedChatGeneration(runtimeEnv, userId, generationId);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);

    expect(result).toEqual(record);
    expect(requestUrl).toContain("id=eq." + generationId);
    expect(requestUrl).toContain("user_id=eq." + userId);
    expect(requestUrl).not.toContain("user_id=eq.some-other-user");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer server-only-service-key");
  });
});
