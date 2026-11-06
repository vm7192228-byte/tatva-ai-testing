import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleChatApiRequest,
  streamAnthropicProvider,
  streamOpenAIProvider,
  streamResponsesProvider,
} from "@/lib/chat-api.server";

const conversation = [
  { role: "user" as const, content: "Reply with a short greeting." },
];

function eventStream(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function readClientEvents(body: string) {
  return body
    .split(/\r?\n/)
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider readiness status", () => {
  it("reports credential presence without returning any API secret", async () => {
    const credentials = {
      OPENAI_API_KEY: "secret-openai-value",
      ANTHROPIC_API_KEY: "secret-anthropic-value",
      DEEPSEEK_API_KEY: "secret-deepseek-value",
      XAI_API_KEY: "secret-xai-value",
    };
    const response = await handleChatApiRequest(
      new Request("https://codeforge.example/api/chat", { method: "GET" }),
      credentials,
    );
    const payload = await response!.json();
    const serialized = JSON.stringify(payload);

    expect(payload.providers.openai).toBe(true);
    expect(payload.providers.anthropic).toBe(true);
    expect(payload.providers.deepseek).toBe(true);
    expect(payload.providers.xai).toBe(true);
    for (const secret of Object.values(credentials)) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("Claude Messages API adapter", () => {
  it("uses Anthropic authentication and normalizes native message events", async () => {
    const mockFetch = vi.fn().mockResolvedValue(eventStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Claude"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]));
    vi.stubGlobal("fetch", mockFetch);

    const response = streamAnthropicProvider({
      label: "Claude",
      apiKey: "test-anthropic-key",
      model: "claude-sonnet-5",
    }, conversation);

    const events = readClientEvents(await response.text());
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const request = JSON.parse(String(init.body));

    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(request.stream).toBe(true);
    expect(request.model).toBe("claude-sonnet-5");
    expect(events.some(event => event["text"] === "Hello from Claude")).toBe(true);
    expect(events.some(event => event["done"] === true)).toBe(true);
    expect(events.some(event => (event["activity"] as { id?: string })?.id === "response-complete")).toBe(true);
  });

  it("does not expose provider error bodies to the client", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: "private provider diagnostic" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));

    const response = streamAnthropicProvider({
      label: "Claude",
      apiKey: "test-anthropic-key",
      model: "claude-sonnet-5",
    }, conversation);
    const output = await response.text();

    expect(output).toContain("Tatv could not complete this reply. Please try again in a moment.");
    expect(output).not.toContain("private provider diagnostic");
    expect(output).not.toContain("test-anthropic-key");
  });
});

describe("OpenAI Responses API adapter", () => {
  it("normalizes output deltas and the completed response event", async () => {
    const mockFetch = vi.fn().mockResolvedValue(eventStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from OpenAI"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]));
    vi.stubGlobal("fetch", mockFetch);

    const response = streamResponsesProvider({
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/responses",
      apiKey: "test-openai-key",
      model: "gpt-6.1-sol",
    }, conversation);

    const events = readClientEvents(await response.text());
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const request = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);

    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(headers.get("authorization")).toBe("Bearer test-openai-key");
    expect(request.model).toBe("gpt-6.1-sol");
    expect(request.stream).toBe(true);
    expect(request.store).toBe(false);
    expect(events.some(event => event["text"] === "Hello from OpenAI")).toBe(true);
    expect(events.some(event => event["done"] === true)).toBe(true);
  });

  it("preserves the selected reasoning setting for Grok", async () => {
    const mockFetch = vi.fn().mockResolvedValue(eventStream([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from Grok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]));
    vi.stubGlobal("fetch", mockFetch);

    const response = streamResponsesProvider({
      id: "xai",
      label: "Grok",
      endpoint: "https://api.x.ai/v1/responses",
      apiKey: "test-xai-key",
      model: "grok-4.7",
      reasoningEffort: "low",
    }, conversation);
    await response.text();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const request = JSON.parse(String(init.body));

    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(request.model).toBe("grok-4.7");
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(request.store).toBe(false);
    expect(request.stream).toBe(true);
  });

  it("classifies provider rate limits without revealing upstream response details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "private upstream diagnostic" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "12" } },
    )));

    const response = streamResponsesProvider({
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/responses",
      apiKey: "test-openai-key",
      model: "gpt-6.1-sol",
    }, conversation);
    const output = await response.text();

    expect(output).toContain("UPSTREAM_RATE_LIMITED");
    expect(output).toContain("Tatv could not complete this reply. Please try again in a moment.");
    expect(output).not.toContain("private upstream diagnostic");
    expect(output).not.toContain("test-openai-key");
  });
});


describe("official Qwen 3.8 Chat Completions adapter", () => {
  it("streams the official model through an authenticated OpenAI-compatible endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(eventStream([
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hello from official Qwen"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal("fetch", mockFetch);

    const response = streamOpenAIProvider({
      id: "qwen",
      label: "Qwen 3.8",
      endpoint: "https://qwen.example.com/v1/chat/completions",
      apiKey: "test-qwen-key",
      model: "Qwen/Qwen3.8-27B",
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    }, conversation);

    const events = readClientEvents(await response.text());
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const request = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);

    expect(url).toBe("https://qwen.example.com/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer test-qwen-key");
    expect(request.model).toBe("Qwen/Qwen3.8-27B");
    expect(request.stream).toBe(true);
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify(request)).not.toContain("test-qwen-key");
    expect(events.some(event => event["text"] === "Hello from official Qwen")).toBe(true);
    expect(events.some(event => event["done"] === true)).toBe(true);
  });
});

describe("DeepSeek Chat Completions adapter", () => {
  it("sends the thinking setting and normalizes data-only SSE chunks", async () => {
    const mockFetch = vi.fn().mockResolvedValue(eventStream([
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hello from DeepSeek"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal("fetch", mockFetch);

    const response = streamOpenAIProvider({
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      apiKey: "test-deepseek-key",
      model: "deepseek-flash",
      extraBody: { thinking: { type: "disabled" } },
    }, conversation);

    const events = readClientEvents(await response.text());
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const request = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);

    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer test-deepseek-key");
    expect(request.model).toBe("deepseek-flash");
    expect(request.stream).toBe(true);
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(request.messages[0].role).toBe("system");
    expect(events.some(event => event["text"] === "Hello from DeepSeek")).toBe(true);
    expect(events.some(event => event["done"] === true)).toBe(true);
  });
});
