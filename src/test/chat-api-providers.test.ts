import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_MODELS,
  handleChatApiRequest,
  isPaidAiChatPlanCode,
  shouldConsumeSuperChatAllowance,
  parseTatvChatMode,
  streamAnthropicProvider,
  streamOpenAIProvider,
  streamResponsesProvider,
} from "@/lib/chat-api.server";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default direct-provider model IDs", () => {
  it("uses current documented model IDs rather than stale aliases", () => {
    expect(DEFAULT_PROVIDER_MODELS).toEqual({
      openai: "gpt-6.1-sol",
      anthropic: "claude-sonnet-5-5",
      deepseek: "deepseek-flash",
      xai: "grok-4.7",
      qwen: "Qwen/Qwen3.8-27B",
    });
  });
});

async function readEnvelope(response: Response) {
  const raw = await response.text();
  return raw.split(/\r?\n\r?\n/).filter(Boolean).flatMap(frame => {
    const data = frame.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim();
    if (!data) return [];
    try { return [JSON.parse(data) as Record<string, unknown>]; }
    catch { return []; }
  });
}

function stubUpstream(body: string, init: ResponseInit = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _requestInit?: RequestInit) => new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", ...(init.headers as Record<string, string> ?? {}) },
    ...init,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("paid AI chat entitlement and shared quota policy", () => {
  it("grants direct provider access only to Plus, yearly Plus and Max plan codes", () => {
    expect(isPaidAiChatPlanCode("pro_monthly")).toBe(true);
    expect(isPaidAiChatPlanCode("pro_yearly")).toBe(true);
    expect(isPaidAiChatPlanCode("creator_monthly")).toBe(true);
    expect(isPaidAiChatPlanCode("starter_monthly")).toBe(false);
    expect(isPaidAiChatPlanCode("free")).toBe(false);
    expect(isPaidAiChatPlanCode(null)).toBe(false);
  });

  it("never consumes a paid chat counter for any Dhwani mode or subscription tier", () => {
    for (const provider of ["smart", "freellmapi", "openai", "anthropic", "deepseek", "xai", "qwen", "cloudflare", "pollinations", "gemini", null]) {
      expect(shouldConsumeSuperChatAllowance(provider, true), String(provider)).toBe(false);
      expect(shouldConsumeSuperChatAllowance(provider, false), String(provider)).toBe(false);
    }
  });

  it("accepts only the three branded Dhwani modes and defaults safely to Smart", () => {
    expect(parseTatvChatMode("flash")).toBe("flash");
    expect(parseTatvChatMode("smart")).toBe("smart");
    expect(parseTatvChatMode("ultra")).toBe("ultra");
    for (const value of [undefined, null, "gemini", "openai", "premium", 123]) {
      expect(parseTatvChatMode(value)).toBe("smart");
    }
  });
});

describe("direct provider readiness", () => {
  it("reports configured providers without returning API keys", async () => {
    const secrets = {
      OPENAI_API_KEY: "openai-test-secret",
      ANTHROPIC_API_KEY: "anthropic-test-secret",
      DEEPSEEK_API_KEY: "deepseek-test-secret",
      XAI_API_KEY: "xai-test-secret",
      QWEN_BASE_URL: "https://qwen.example.com/v1",
      QWEN_API_KEY: "qwen-test-secret",
      GEMINI_API_KEY: "gemini-must-remain-disabled",
    };
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", { method: "GET" }),
      secrets,
    );

    expect(response).not.toBeNull();
    const payload = await response!.json();
    expect(payload.providers.openai).toBe(true);
    expect(payload.providers.anthropic).toBe(true);
    expect(payload.providers.deepseek).toBe(true);
    expect(payload.providers.xai).toBe(true);
    expect(payload.providers.qwen).toBe(true);
    expect(payload.providers.gemini).toBe(false);
    const serialized = JSON.stringify(payload);
    for (const key of Object.values(secrets)) expect(serialized).not.toContain(key);
  });

  it("does not enable direct Gemini chat even when a server key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", {
        method: "GET",
      }),
      { GEMINI_API_KEY: "gemini-must-remain-disabled" },
    );
    expect(response).not.toBeNull();
    const payload = await response!.json();
    expect(payload.providers.gemini).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("gemini-must-remain-disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS Qwen inference endpoints even when a key is present", async () => {
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", { method: "GET" }),
      { QWEN_BASE_URL: "http://qwen.internal/v1", QWEN_API_KEY: "qwen-test-secret" },
    );
    const payload = await response!.json();
    expect(payload.providers.qwen).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("qwen-test-secret");
  });

  it("reports an unconfigured provider as unavailable", async () => {
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", { method: "GET" }),
      {},
    );
    expect(response).not.toBeNull();
    const payload = await response!.json();
    expect(payload.providers.openai).toBe(false);
    expect(payload.providers.anthropic).toBe(false);
    expect(payload.providers.deepseek).toBe(false);
    expect(payload.providers.xai).toBe(false);
    expect(payload.providers.qwen).toBe(false);
  });
});

describe("direct provider plan gate", () => {
  it("keeps OpenAI, Claude, DeepSeek, Grok and Qwen behind the CodeForge subscription gate", async () => {
    const providers = ["openai", "anthropic", "deepseek", "xai", "qwen"] as const;
    for (const [index, provider] of providers.entries()) {
      const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://codeforge.example",
          "x-real-ip": "198.51.100." + String(140 + index),
        },
        body: JSON.stringify({
          provider,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }), {});

      expect(response).not.toBeNull();
      expect(response!.status).toBe(402);
      const payload = await response!.json();
      expect(payload.error).toBe("SUBSCRIPTION_REQUIRED");
    }
  });
});

describe("provider preflight before quota consumption", () => {
  it("rejects an invalid OpenAI model before creating any usage event", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/v1/user") {
        return new Response(JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          user_metadata: { display_name: "Creator" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/rest/v1/cf_subscriptions") {
        return new Response(JSON.stringify([{
          plan_code: "pro_monthly",
          starts_at: null,
          expires_at: null,
        }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/rest/v1/rpc/cf_allow_transcription_attempt") {
        return Response.json({ allowed: true, attempts: 1, retryAfterSeconds: 60 });
      }
      throw new Error("Unexpected upstream request: " + url.pathname);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://codeforge.example",
        cookie: "cf_access=valid-test-access-token",
        "x-real-ip": "198.51.100.211",
      },
      body: JSON.stringify({
        provider: "openai",
        messages: [{ role: "user", content: "Hello" }],
      }),
    }), {
      SUPABASE_URL: "https://supabase.example",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_MODEL: "invalid model id",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(500);
    const payload = await response!.json();
    expect(payload.error).toBe("INVALID_SERVER_CONFIG");
    const fetchedUrls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(fetchedUrls).toContain("https://supabase.example/rest/v1/rpc/cf_allow_transcription_attempt");
    expect(fetchedUrls).not.toContain("https://supabase.example/rest/v1/rpc/cf_consume_usage_quota");
  });
});

describe("Claude Messages API stream adapter", () => {
  it("forwards text deltas and only completes after message_stop", async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";
    const fetchMock = stubUpstream(frames);
    const response = streamAnthropicProvider(
      { label: "Claude", apiKey: "anthropic-test-secret", model: "claude-sonnet-5" },
      [{ role: "user", content: "Hello" }],
    );
    const events = await readEnvelope(response);

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ "x-api-key": "anthropic-test-secret", "anthropic-version": "2023-06-01" });
    expect(String(request?.body)).not.toContain("anthropic-test-secret");
    expect(events.some(event => event["text"] === "Hello")).toBe(true);
    expect(events.some(event => event["done"] === true && event["error"])).toBe(false);
    expect(events.some(event => event["done"] === true && event["model"] === "claude-sonnet-5")).toBe(true);
  });

  it("does not mark a max_tokens response as complete", async () => {
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";
    stubUpstream(frames);
    const response = streamAnthropicProvider(
      { label: "Claude", apiKey: "anthropic-test-secret", model: "claude-sonnet-5" },
      [{ role: "user", content: "Write a long answer" }],
    );
    const events = await readEnvelope(response);

    expect(events.some(event => event["text"] === "Partial")).toBe(true);
    expect(events.some(event => event["error"] && event["code"] === "OUTPUT_LIMIT_REACHED")).toBe(true);
    expect(events.some(event => event["done"] === true && event["model"])).toBe(false);
  });

  it("translates a 529 overload response into a safe retry message", async () => {
    stubUpstream('{"error":{"type":"overloaded_error","message":"internal details"}}', {
      status: 529,
      headers: { "content-type": "application/json", "retry-after": "2" },
    });
    const response = streamAnthropicProvider(
      { label: "Claude", apiKey: "anthropic-test-secret", model: "claude-sonnet-5" },
      [{ role: "user", content: "Hello" }],
    );
    const events = await readEnvelope(response);
    const failure = events.find(event => event["error"]);

    expect(failure?.["code"]).toBe("UPSTREAM_UNAVAILABLE");
    expect(failure?.["error"]).toBe("Dhwani could not complete this reply. Please try again in a moment.");
    expect(failure?.["retryAfterSeconds"]).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("internal details");
  });
});

describe("OpenAI and Grok Responses API stream adapter", () => {
  it("streams OpenAI output_text deltas and waits for response.completed", async () => {
    const frames = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test"}}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Open"}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"AI"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
    ].join("\n\n") + "\n\n";
    const fetchMock = stubUpstream(frames);
    const response = streamResponsesProvider(
      { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1/responses", apiKey: "openai-test-secret", model: "gpt-6.1-sol" },
      [{ role: "user", content: "Hello" }],
    );
    const events = await readEnvelope(response);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer openai-test-secret" });
    expect(requestBody.model).toBe("gpt-6.1-sol");
    expect(requestBody.store).toBe(false);
    expect(events.some(event => event["text"] === "Open")).toBe(true);
    expect(events.some(event => event["text"] === "AI")).toBe(true);
    expect(events.some(event => event["done"] === true && event["model"] === "gpt-6.1-sol")).toBe(true);
  });

  it("treats response.incomplete as an interrupted answer", async () => {
    const frames = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial"}',
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
    ].join("\n\n") + "\n\n";
    const fetchMock = stubUpstream(frames);
    const response = streamResponsesProvider(
      { id: "xai", label: "Grok", endpoint: "https://api.x.ai/v1/responses", apiKey: "xai-test-secret", model: "grok-4.7", reasoningEffort: "low" },
      [{ role: "user", content: "Hello" }],
    );
    const events = await readEnvelope(response);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.ai/v1/responses");
    expect(requestBody.reasoning).toEqual({ effort: "low" });
    expect(events.some(event => event["text"] === "Partial")).toBe(true);
    expect(events.some(event => event["error"] && event["code"] === "OUTPUT_LIMIT_REACHED")).toBe(true);
    expect(events.some(event => event["done"] === true && event["model"])).toBe(false);
  });
});

describe("provider throttling and safe error handling", () => {
  it("maps a DeepSeek 429 response and Retry-After header without echoing provider details", async () => {
    stubUpstream('{"error":{"message":"raw account-specific details"}}', {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    });
    const response = streamOpenAIProvider(
      {
        id: "deepseek",
        label: "DeepSeek",
        endpoint: "https://api.deepseek.com/chat/completions",
        apiKey: "deepseek-test-secret",
        model: "deepseek-flash",
      },
      [{ role: "user", content: "Hello" }],
    );
    const events = await readEnvelope(response);
    const failure = events.find(event => event["error"]);

    expect(failure?.["code"]).toBe("UPSTREAM_RATE_LIMITED");
    expect(failure?.["retryAfterSeconds"]).toBeUndefined();
    expect(failure?.["error"]).toBe("Dhwani could not complete this reply. Please try again in a moment.");
    expect(JSON.stringify(events)).not.toContain("raw account-specific details");
    expect(JSON.stringify(events)).not.toContain("deepseek-test-secret");
  });
});

describe("DeepSeek OpenAI-compatible stream adapter", () => {
  it("forwards deltas, respects [DONE], and sends the thinking option", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"internal reasoning must stay hidden"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Deep"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Seek"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const fetchMock = stubUpstream(frames);
    const response = streamOpenAIProvider(
      {
        id: "deepseek",
        label: "DeepSeek",
        endpoint: "https://api.deepseek.com/chat/completions",
        apiKey: "deepseek-test-secret",
        model: "deepseek-flash",
        extraBody: { thinking: { type: "disabled" } },
      },
      [{ role: "user", content: "Hello" }],
    );
    const events = await readEnvelope(response);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(requestBody.model).toBe("deepseek-flash");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer deepseek-test-secret" });
    expect(requestBody.thinking).toEqual({ type: "disabled" });
    expect(events.some(event => event["text"] === "Deep")).toBe(true);
    expect(events.some(event => event["text"] === "Seek")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("internal reasoning must stay hidden");
    expect(events.some(event => event["done"] === true && event["model"])).toBe(true);
  });
});


describe("CodeForge video creative kit prompt mode", () => {
  it("sends video template requests to chat with two copy-ready creative options", async () => {
    const firstTurn = [
      "data: " + JSON.stringify({
        choices: [{
          index: 0,
          delta: { content: "Here are two distinct video templates." },
          finish_reason: null,
        }],
      }),
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          email: "alpha@example.com",
          user_metadata: { display_name: "Alpha Tester" },
        });
      }
      if (url.includes("/rest/v1/cf_subscriptions")) return Response.json([]);
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(firstTurn, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://codeforge.example",
        cookie: "cf_access=alpha-user-access-token",
        "x-real-ip": "198.51.100.248",
      },
      body: JSON.stringify({
        provider: "smart",
        videoCreativeKit: true,
        messages: [{ role: "user", content: "Give me two templates for a video about photosynthesis." }],
      }),
    }), {
      SUPABASE_URL: "https://supabase.example",
      SUPABASE_ANON_KEY: "publishable-test-key",
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEnvelope(response!);
    expect(events.some(event => event["text"] === "Here are two distinct video templates.")).toBe(true);
    expect(requestBodies).toHaveLength(1);

    const messages = requestBodies[0]?.["messages"] as Array<Record<string, unknown>>;
    const userMessage = messages.find(message => message["role"] === "user");
    expect(String(userMessage?.["content"])).toContain("[CODEFORGE VIDEO CREATIVE KIT MODE]");
    expect(String(userMessage?.["content"])).toContain("two genuinely distinct, copy-ready options");
    expect(String(userMessage?.["content"])).toContain("scene-by-scene storyboard");
    expect(String(userMessage?.["content"])).toContain("Never claim that a video was rendered.");
  });
});

describe("CodeForge Smart native server-tool routing", () => {
  it("runs a validated tool call through the private CodeForge gateway and continues the same streamed conversation", async () => {
    const firstTurn = [
      "data: " + JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_calculator_1",
              type: "function",
              function: { name: "calculator", arguments: JSON.stringify({ expression: "6 * 7" }) },
            }],
          },
          finish_reason: null,
        }],
      }),
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const secondTurn = [
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "6 times 7 is 42." }, finish_reason: null }] }),
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return Response.json({
          id: "22222222-2222-4222-8222-222222222222",
          email: "alpha@example.com",
          user_metadata: { display_name: "Alpha Tester" },
        });
      }
      if (url.includes("/rest/v1/cf_subscriptions")) return Response.json([]);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      return new Response(requestBodies.length === 1 ? firstTurn : secondTurn, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://codeforge.example",
        cookie: "cf_access=alpha-user-access-token",
        "x-real-ip": "198.51.100.249",
      },
      body: JSON.stringify({
        provider: "smart",
        messages: [{ role: "user", content: "What is 6 times 7?" }],
      }),
    }), {
      SUPABASE_URL: "https://supabase.example",
      SUPABASE_ANON_KEY: "publishable-test-key",
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
      CODEFORGE_GATEWAY_MODEL: "auto",
      TAVILY_API_KEY: "test-tavily-key",
      GEMINI_API_KEY: "must-not-be-used-for-tool-enabled-chat",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const events = await readEnvelope(response!);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.["model"]).toBe("auto");
    expect(requestBodies[0]?.["stream"]).toBe(true);
    expect(requestBodies[0]?.["tool_choice"]).toBe("auto");
    expect(requestBodies[0]?.["tools"]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "calculator" }),
      }),
    ]));
    const continuation = requestBodies[1]?.["messages"] as Array<Record<string, unknown>>;
    expect(continuation).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({
            id: "call_calculator_1",
            function: expect.objectContaining({ name: "calculator" }),
          }),
        ]),
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_calculator_1",
        content: expect.stringContaining('"result":42'),
      }),
    ]));
    expect(events.some(event => event["text"] === "6 times 7 is 42.")).toBe(true);
    expect(events.some(event => event["done"] === true && event["model"] === "auto")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("alpha-user-access-token");
    expect(JSON.stringify(events)).not.toContain("must-not-be-used-for-tool-enabled-chat");
  });
});
