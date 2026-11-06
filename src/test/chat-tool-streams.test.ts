import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamAnthropicWithServerTools,
  streamChatCompletionsWithServerTools,
  streamGeminiWithServerTools,
  streamResponsesWithServerTools,
} from "../lib/chat-tool-streams.server";

function eventStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const messages = [{ role: "user" as const, content: "Find current documentation about secure streaming." }];
const runtimeEnv = { TAVILY_API_KEY: "private-tavily-key" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI Responses server tool continuation", () => {
  it("executes an allow-listed search and sends the function output into a follow-up model turn", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(eventStream([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs_preserve_1","summary":[]},{"type":"function_call","call_id":"call_search_1","name":"web_search","arguments":"{\\"query\\":\\"secure streaming documentation\\"}"}]}}\n\n',
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          title: "Secure streaming guide",
          url: "https://example.com/secure-streaming",
          content: "Use persisted events and validate the caller's ownership.",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(eventStream([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Use persisted events and enforce owner checks."}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message"}]}}\n\n',
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamResponsesWithServerTools(
      {
        label: "OpenAI",
        endpoint: "https://api.openai.com/v1/responses",
        apiKey: "private-openai-key",
        model: "gpt-test",
      },
      messages,
      [],
      "You are CodeForge AI.",
      false,
      [],
      runtimeEnv,
    );
    const output = await response.text();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    const followUpRequest = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body));
    expect(firstRequest.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["calculator", "current_time", "web_search"]),
    );
    expect(followUpRequest.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "reasoning",
        id: "rs_preserve_1",
      }),
      expect.objectContaining({
        type: "function_call",
        call_id: "call_search_1",
        name: "web_search",
      }),
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_search_1",
        output: expect.stringContaining("https://example.com/secure-streaming"),
      }),
    ]));
    expect(output).toContain("Use persisted events and enforce owner checks.");
    expect(output).toContain('"done":true');
    expect(output).not.toContain("private-openai-key");
    expect(output).not.toContain("private-tavily-key");
  });

  it("stops repeated tool-call IDs before executing the duplicate", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(eventStream([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"same_call","name":"web_search","arguments":"{\\"query\\":\\"first search\\"}"}]}}\n\n',
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(eventStream([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"same_call","name":"web_search","arguments":"{\\"query\\":\\"duplicate search\\"}"}]}}\n\n',
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamResponsesWithServerTools(
      { label: "OpenAI", endpoint: "https://api.openai.com/v1/responses", apiKey: "secret", model: "gpt-test" },
      messages,
      [],
      "You are CodeForge AI.",
      false,
      [],
      runtimeEnv,
    );
    const output = await response.text();

    expect(output).toContain("DUPLICATE_TOOL_CALL");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects duplicate call IDs in one Responses batch before executing any tool", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      'event: response.completed\ndata: ' + JSON.stringify({
        type: "response.completed",
        response: { output: [
          { type: "function_call", call_id: "duplicate_batch", name: "web_search", arguments: JSON.stringify({ query: "first" }) },
          { type: "function_call", call_id: "duplicate_batch", name: "web_search", arguments: JSON.stringify({ query: "second" }) },
        ] },
      }) + "\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamResponsesWithServerTools(
      { label: "OpenAI", endpoint: "https://api.openai.com/v1/responses", apiKey: "secret", model: "gpt-test" },
      messages, [], "You are CodeForge AI.", false, [], runtimeEnv,
    );
    const output = await response.text();
    expect(output).toContain("DUPLICATE_TOOL_CALL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Anthropic Messages server tool continuation", () => {
  it("preserves the assistant tool_use and user tool_result blocks for the next turn", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(eventStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_search_1","name":"web_search","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"secure streaming documentation\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          title: "Secure streaming guide",
          url: "https://example.com/secure-streaming",
          content: "Use an ordered event log with caller ownership.",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(eventStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Persist the event log and verify ownership."}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamAnthropicWithServerTools(
      { label: "Claude", apiKey: "private-anthropic-key", model: "claude-test" },
      messages,
      [],
      "You are CodeForge AI.",
      [],
      runtimeEnv,
    );
    const output = await response.text();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    const followUpRequest = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body));
    expect(firstRequest.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["calculator", "current_time", "web_search"]),
    );
    expect(followUpRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "tool_use", id: "toolu_search_1", name: "web_search" }),
        ]),
      }),
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "toolu_search_1",
            content: expect.stringContaining("https://example.com/secure-streaming"),
          }),
        ]),
      }),
    ]));
    expect(output).toContain("Persist the event log and verify ownership.");
    expect(output).toContain('"done":true');
    expect(output).not.toContain("private-anthropic-key");
    expect(output).not.toContain("private-tavily-key");
  });

  it("rejects duplicate Anthropic tool IDs in a batch before executing any tool", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      'event: content_block_start\ndata: ' + JSON.stringify({
        type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "anthropic_duplicate", name: "web_search", input: { query: "first" } },
      }) + "\n\n",
      'event: content_block_start\ndata: ' + JSON.stringify({
        type: "content_block_start", index: 1,
        content_block: { type: "tool_use", id: "anthropic_duplicate", name: "web_search", input: { query: "second" } },
      }) + "\n\n",
      'event: message_delta\ndata: ' + JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }) + "\n\n",
      'event: message_stop\ndata: ' + JSON.stringify({ type: "message_stop" }) + "\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamAnthropicWithServerTools(
      { label: "Claude", apiKey: "secret", model: "claude-test" },
      messages, [], "You are CodeForge AI.", [], runtimeEnv,
    );
    const output = await response.text();
    expect(output).toContain("INVALID_TOOL_SEQUENCE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe("DeepSeek Chat Completions server tool continuation", () => {
  it("preserves NO_PROVIDER_MODEL from a private gateway in tool-enabled mode", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(
      { error: { code: "NO_PROVIDER_MODEL", message: "Internal local catalog detail." } },
      { status: 503 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamChatCompletionsWithServerTools(
      {
        id: "codeforgeGatewayFallback3",
        label: "Tatv third private backup gateway",
        endpoint: "https://quaternary-gateway.example/v1/chat/completions",
        apiKey: "verified-user-access-token",
        model: "auto",
      },
      messages,
      [],
      "You are CodeForge AI.",
      [],
      runtimeEnv,
    );

    const output = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output).toContain('"code":"NO_PROVIDER_MODEL"');
    expect(output).toContain("no enabled chat model");
    expect(output).not.toContain("Internal local catalog detail");
    expect(output).not.toContain("verified-user-access-token");
  });

  it("reassembles streamed tool-call fragments and preserves reasoning_content for the follow-up turn", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(eventStream([
        "data: " + JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              reasoning_content: "I should verify this from a source.",
              tool_calls: [{
                index: 0,
                id: "deepseek_call_1",
                type: "function",
                function: { name: "web_search", arguments: "{\"query\":\"DeepSeek function calling documentation\"}" },
              }],
            },
            finish_reason: null,
          }],
        }) + "\n\n",
        "data: " + JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }) + "\n\n",
        "data: [DONE]\n\n",
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          title: "DeepSeek tool calling guide",
          url: "https://api-docs.deepseek.com/guides/tool_calls/",
          content: "Tools are declared by the client and executed by the application.",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(eventStream([
        "data: " + JSON.stringify({
          choices: [{ index: 0, delta: { content: "The application executes the verified tool call." }, finish_reason: null }],
        }) + "\n\n",
        "data: " + JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) + "\n\n",
        "data: [DONE]\n\n",
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamChatCompletionsWithServerTools(
      {
        label: "DeepSeek",
        endpoint: "https://api.deepseek.com/chat/completions",
        apiKey: "private-deepseek-key",
        model: "deepseek-test",
        extraBody: { thinking: { type: "enabled" } },
      },
      messages,
      [],
      "You are CodeForge AI.",
      [],
      runtimeEnv,
    );
    const output = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    const followUpRequest = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body));
    expect(firstRequest.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "web_search" }) }),
    ]));
    expect(followUpRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "I should verify this from a source.",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({
            id: "deepseek_call_1",
            function: expect.objectContaining({ name: "web_search" }),
          }),
        ]),
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "deepseek_call_1",
        content: expect.stringContaining("https://api-docs.deepseek.com/guides/tool_calls/"),
      }),
    ]));
    expect(output).toContain("The application executes the verified tool call.");
    expect(output).toContain('"done":true');
    expect(output).not.toContain("private-deepseek-key");
    expect(output).not.toContain("private-tavily-key");
  });

  it("rejects duplicate Chat Completions call IDs in one batch before executing tools", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      "data: " + JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [
            { index: 0, id: "chat_duplicate", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "first" }) } },
            { index: 1, id: "chat_duplicate", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "second" }) } },
          ] },
          finish_reason: "tool_calls",
        }],
      }) + "\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamChatCompletionsWithServerTools(
      { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", apiKey: "secret", model: "deepseek-test" },
      messages, [], "You are CodeForge AI.", [], runtimeEnv,
    );
    const output = await response.text();
    expect(output).toContain("DUPLICATE_TOOL_CALL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects streamed Chat Completions tool calls without a valid index", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      "data: " + JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{
            id: "missing_index",
            type: "function",
            function: { name: "web_search", arguments: JSON.stringify({ query: "must not run" }) },
          }] },
          finish_reason: "tool_calls",
        }],
      }) + "\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamChatCompletionsWithServerTools(
      { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", apiKey: "secret", model: "deepseek-test" },
      messages, [], "You are CodeForge AI.", [], runtimeEnv,
    );
    const output = await response.text();
    expect(output).toContain("UPSTREAM_STREAM_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a batch that exceeds the total tool-call limit before executing it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      "data: " + JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: Array.from({ length: 5 }, (_, index) => ({
            index,
            id: "over_limit_" + index,
            type: "function",
            function: { name: "calculator", arguments: JSON.stringify({ expression: "2 + 2" }) },
          })) },
          finish_reason: "tool_calls",
        }],
      }) + "\n\n",
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamChatCompletionsWithServerTools(
      { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", apiKey: "secret", model: "deepseek-test" },
      messages, [], "You are CodeForge AI.", [], {},
    );
    const output = await response.text();
    expect(output).toContain("TOOL_CALL_LIMIT_REACHED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured maximum number of tool rounds", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(eventStream([
      "data: " + JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{
            index: 0,
            id: "round_" + fetchMock.mock.calls.length,
            type: "function",
            function: { name: "calculator", arguments: JSON.stringify({ expression: "2 + 2" }) },
          }] },
          finish_reason: "tool_calls",
        }],
      }) + "\n\n",
      "data: [DONE]\n\n",
    ])));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamChatCompletionsWithServerTools(
      { label: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", apiKey: "secret", model: "deepseek-test" },
      messages, [], "You are CodeForge AI.", [], {},
    );
    const output = await response.text();
    expect(output).toContain("TOOL_CALL_LIMIT_REACHED");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});


describe("Gemini native function-calling continuation", () => {
  it("preserves the provider function-call part and sends a matching functionResponse", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(eventStream([
        "data: " + JSON.stringify({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                functionCall: {
                  id: "gemini_call_1",
                  name: "calculator",
                  args: { expression: "5 * 7" },
                },
                thoughtSignature: "provider-thought-signature",
              }],
            },
            finishReason: "STOP",
          }],
        }) + "\n\n",
      ]))
      .mockResolvedValueOnce(eventStream([
        "data: " + JSON.stringify({
          candidates: [{
            content: { role: "model", parts: [{ text: "5 multiplied by 7 is 35." }] },
            finishReason: "STOP",
          }],
        }) + "\n\n",
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamGeminiWithServerTools(
      { apiKey: "private-gemini-key", candidates: ["gemini-test"] },
      messages,
      [],
      "You are CodeForge AI.",
      [],
      {},
    );
    const output = await response.text();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(firstRequest.tools[0].functionDeclarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "calculator" }),
      expect.objectContaining({ name: "current_time" }),
    ]));
    expect(secondRequest.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "model",
        parts: expect.arrayContaining([
          expect.objectContaining({
            functionCall: expect.objectContaining({
              id: "gemini_call_1",
              name: "calculator",
            }),
            thoughtSignature: "provider-thought-signature",
          }),
        ]),
      }),
      expect.objectContaining({
        role: "user",
        parts: expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              id: "gemini_call_1",
              name: "calculator",
              response: expect.objectContaining({ result: 35 }),
            }),
          }),
        ]),
      }),
    ]));
    expect(output).toContain("5 multiplied by 7 is 35.");
    expect(output).toContain('"done":true');
    expect(output).not.toContain("private-gemini-key");
  });

  it("does not execute partial function calls when Gemini reports a malformed completion", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      "data: " + JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: {
                id: "gemini_malformed_call",
                name: "web_search",
                args: { query: "must not execute" },
              },
            }],
          },
          finishReason: "MALFORMED_FUNCTION_CALL",
        }],
      }) + "\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const response = streamGeminiWithServerTools(
      { apiKey: "private-gemini-key", candidates: ["gemini-test"] },
      messages,
      [],
      "You are CodeForge AI.",
      [],
      { TAVILY_API_KEY: "private-tavily-key" },
    );
    const output = await response.text();

    expect(output).toContain("UPSTREAM_STREAM_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output).not.toContain("must not execute");
    expect(output).not.toContain("private-gemini-key");
    expect(output).not.toContain("private-tavily-key");
  });

  it("rejects duplicate Gemini function-call IDs in one batch before executing tools", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(eventStream([
      "data: " + JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [
              { functionCall: { id: "gemini_duplicate", name: "web_search", args: { query: "first" } } },
              { functionCall: { id: "gemini_duplicate", name: "web_search", args: { query: "second" } } },
            ],
          },
          finishReason: "STOP",
        }],
      }) + "\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const response = streamGeminiWithServerTools(
      { apiKey: "secret", candidates: ["gemini-test"] },
      messages, [], "You are CodeForge AI.", [], runtimeEnv,
    );
    const output = await response.text();
    expect(output).toContain("INVALID_TOOL_SEQUENCE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
