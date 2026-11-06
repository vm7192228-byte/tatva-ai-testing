import { describe, expect, it } from "vitest";
import { streamWithFailover } from "../lib/chat-failover.server";

function sse(...events: Array<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function events(response: Response) {
  return (await response.text())
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map(frame => JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith("data:"))!.slice(5).trim()) as Record<string, unknown>);
}

describe("streamWithFailover", () => {
  it("passes a healthy first provider through and never starts the backup", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse({ status: "connecting" }, { text: "Hello" }, { done: true }) },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "unused" }, { done: true }); } },
    ]));
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["Hello"]);
    expect(backupStarted).toBe(false);
  });

  it("retries the explicit personal FreeLLMAPI quota-exhausted signal", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "FreeLLMAPI personal route", start: () => sse({
        error: "FreeLLMAPI quota is exhausted.",
        code: "FREELLMAPI_QUOTA_EXHAUSTED",
        done: true,
      }) },
      { label: "Private CodeForge gateway", start: () => {
        backupStarted = true;
        return sse({ text: "Private fallback answered." }, { done: true });
      } },
    ]));

    expect(backupStarted).toBe(true);
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["Private fallback answered."]);
    expect(output.some(item => item["status"] === "retrying")).toBe(true);
  });

  it("switches providers after an error before any answer text", async () => {
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse({ status: "connecting" }, { error: "rate limited", code: "UPSTREAM_UNAVAILABLE", done: true }) },
      { label: "B", start: () => sse({ text: "Backup answer" }, { done: true }) },
    ]));
    expect(output.some(item => item["error"])).toBe(false);
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["Backup answer"]);
    expect(output.some(item => item["status"] === "retrying")).toBe(true);
  });

  it("falls through provider credential, permission, billing and model errors from the private gateway", async () => {
    for (const code of ["UPSTREAM_AUTH_FAILED", "UPSTREAM_PERMISSION_DENIED", "UPSTREAM_BILLING_REQUIRED", "UPSTREAM_MODEL_NOT_FOUND", "UPSTREAM_RATE_LIMITED"]) {
      let backupStarted = false;
      const output = await events(streamWithFailover([
        { label: "Private gateway", start: () => sse({ error: "provider configuration needs attention", code, done: true }) },
        { label: "Direct provider", start: () => {
          backupStarted = true;
          return sse({ text: "Direct provider answered." }, { done: true });
        } },
      ]));
      expect(backupStarted, code).toBe(true);
      expect(output.some(item => item["text"] === "Direct provider answered.")).toBe(true);
      expect(JSON.stringify(output)).not.toContain("provider configuration needs attention");
    }
  });

  it("retries every non-policy upstream failure for the shared FreeLLMAPI or direct-provider hops", async () => {
    for (const code of ["UPSTREAM_RATE_LIMITED", "UPSTREAM_REQUEST_FAILED", "UPSTREAM_AUTH_FAILED"]) {
      let backupStarted = false;
      const output = await events(streamWithFailover([
        { label: "Shared provider", retryErrors: true, start: () => sse({ error: "shared provider diagnostics", code, done: true }) },
        { label: "Next provider", start: () => {
          backupStarted = true;
          return sse({ text: "Fallback answered." }, { done: true });
        } },
      ]));
      expect(backupStarted, code).toBe(true);
      expect(output.some(item => item["text"] === "Fallback answered.")).toBe(true);
      expect(JSON.stringify(output)).not.toContain("shared provider diagnostics");
    }
  });

  it("does not bypass a private gateway user-access, account block or user quota decision", async () => {
    for (const code of ["PRIVATE_GATEWAY_ACCESS_DENIED", "USER_AUTH_REQUIRED", "AUTH_REQUIRED", "USER_BANNED", "ACCOUNT_SUSPENDED", "USER_ACCESS_BLOCKED", "USER_PERMISSION_DENIED", "USER_RATE_LIMITED", "USER_QUOTA_EXCEEDED", "PLAN_LIMIT_REACHED"]) {
      let backupStarted = false;
      const output = await events(streamWithFailover([
        { label: "Private gateway", retryErrors: true, start: () => sse({ error: "user access blocked", code, done: true }) },
        { label: "Direct provider", retryErrors: true, start: () => {
          backupStarted = true;
          return sse({ text: "must not bypass the user's access decision" }, { done: true });
        } },
      ]));
      expect(backupStarted, code).toBe(false);
      expect(output[output.length - 1]).toMatchObject({
        error: "Dhwani could not complete this reply. Please try again in a moment.",
        code: "AI_REQUEST_FAILED",
        done: true,
      });
      expect(JSON.stringify(output)).not.toContain("user access blocked");
    }
  });

  it("does not route around a provider content-policy decision", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse({ error: "The provider blocked this request.", code: "UPSTREAM_CONTENT_FILTERED", done: true }) },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "must not bypass the first provider policy" }, { done: true }); } },
    ]));
    expect(backupStarted).toBe(false);
    expect(output[output.length - 1]).toMatchObject({
      error: "Dhwani could not complete this reply. Please try again in a moment.",
      code: "AI_REQUEST_FAILED",
      done: true,
    });
    expect(JSON.stringify(output)).not.toContain("The provider blocked this request.");
  });

  it("never mixes models once answer text has reached the user", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse({ text: "Partial" }, { error: "stream stalled", done: true }) },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "Other model" }, { done: true }); } },
    ]));
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["Partial"]);
    expect(output.some(item => item["error"] === "Dhwani could not complete this reply. Please try again in a moment.")).toBe(true);
    expect(JSON.stringify(output)).not.toContain("stream stalled");
    expect(backupStarted).toBe(false);
  });

  it("falls back when the Smart tool adapter reports an unsupported tool protocol before any tool starts", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      {
        label: "CodeForge Smart",
        start: () => sse(
          { status: "connecting" },
          { error: "upstream does not support native tool calls", code: "UPSTREAM_TOOL_PROTOCOL_UNSUPPORTED", done: true },
        ),
      },
      {
        label: "Backup gateway",
        start: () => {
          backupStarted = true;
          return sse({ text: "Backup gateway handled the same safe request." }, { done: true });
        },
      },
    ]));
    expect(backupStarted).toBe(true);
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual([
      "Backup gateway handled the same safe request.",
    ]);
    expect(output.some(item => item["status"] === "retrying")).toBe(true);
  });

  it("does not replay a request on another provider after a tool execution starts", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse(
        { activity: { id: "tool-1", label: "Running web search", state: "active" } },
        { error: "provider stream failed after tool execution", done: true },
      ) },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "must not rerun" }, { done: true }); } },
    ]));
    expect(output.some(item => (item["activity"] as Record<string, unknown> | undefined)?.["id"] === "tool-1")).toBe(true);
    expect(output.some(item => item["error"] === "Dhwani could not complete this reply. Please try again in a moment.")).toBe(true);
    expect(JSON.stringify(output)).not.toContain("provider stream failed after tool execution");
    expect(backupStarted).toBe(false);
  });

  it("does not replay a request after creating an approval even before answer text", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse(
        { approvalRequired: { id: "approval-1", toolName: "facebook_publish_post" } },
        { error: "provider failed after approval was created", done: true },
      ) },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "must not duplicate approval" }, { done: true }); } },
    ]));
    expect(output.some(item => (item["approvalRequired"] as Record<string, unknown> | undefined)?.["id"] === "approval-1")).toBe(true);
    expect(output.some(item => item["error"] === "Dhwani could not complete this reply. Please try again in a moment.")).toBe(true);
    expect(JSON.stringify(output)).not.toContain("provider failed after approval was created");
    expect(backupStarted).toBe(false);
  });

  it("returns one stable user-safe message when all attempts fail", async () => {
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse({ error: "first", code: "UPSTREAM_UNAVAILABLE", done: true }) },
      { label: "B", start: () => sse({ error: "second", code: "UPSTREAM_UNAVAILABLE", done: true }) },
    ]));
    expect(output[output.length - 1]).toMatchObject({
      error: "Dhwani could not complete this reply. Please try again in a moment.",
      code: "AI_REQUEST_FAILED",
      done: true,
    });
  });

  it("keeps the empty-model diagnosis when every private gateway has no enabled chat model", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "Primary gateway", start: () => sse({ error: "internal catalog detail", code: "NO_PROVIDER_MODEL", done: true }) },
      { label: "Backup gateway", start: () => {
        backupStarted = true;
        return sse({ error: "another internal catalog detail", code: "NO_PROVIDER_MODEL", done: true });
      } },
    ]));

    expect(backupStarted).toBe(true);
    expect(output[output.length - 1]).toMatchObject({
      error: "Dhwani could not complete this reply. Please try again in a moment.",
      code: "AI_REQUEST_FAILED",
      done: true,
    });
    expect(JSON.stringify(output)).not.toContain("internal catalog detail");
  });

  it("uses the general availability message when an empty catalog is mixed with an unavailable gateway", async () => {
    const output = await events(streamWithFailover([
      { label: "Primary gateway", start: () => sse({ error: "empty catalog", code: "NO_PROVIDER_MODEL", done: true }) },
      { label: "Backup gateway", start: () => sse({ error: "network unavailable", code: "UPSTREAM_UNAVAILABLE", done: true }) },
    ]));

    expect(output[output.length - 1]).toMatchObject({
      error: "Dhwani could not complete this reply. Please try again in a moment.",
      code: "AI_REQUEST_FAILED",
      done: true,
    });
  });

  it("continues after an adapter throws while starting", async () => {
    const output = await events(streamWithFailover([
      { label: "A", start: () => { throw new Error("private adapter detail"); } },
      { label: "B", start: () => sse({ text: "ok" }, { done: true }) },
    ]));
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["ok"]);
    expect(JSON.stringify(output)).not.toContain("private adapter detail");
  });

  it("does not forward non-SSE upstream bodies to the browser", async () => {
    const output = await events(streamWithFailover([
      { label: "A", start: () => new Response('{"secret":"upstream body"}', { status: 502, headers: { "content-type": "application/json" } }) },
      { label: "B", start: () => sse({ text: "safe backup" }, { done: true }) },
    ]));
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["safe backup"]);
    expect(JSON.stringify(output)).not.toContain("upstream body");
  });

  it("does not start a backup after the client aborts", async () => {
    const controller = new AbortController();
    let backupStarted = false;
    const response = streamWithFailover([
      { label: "A", start: () => { controller.abort(); return sse({ error: "aborted", done: true }); } },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "must not run" }, { done: true }); } },
    ], [], controller.signal);
    expect(await events(response)).toEqual([]);
    expect(backupStarted).toBe(false);
  });

  it("bounds the number of provider attempts", async () => {
    let started = 0;
    const attempts = Array.from({ length: 13 }, (_, index) => ({
      label: "Provider " + index,
      start: () => { started += 1; return sse({ error: "failed", code: "UPSTREAM_UNAVAILABLE", done: true }); },
    }));
    const output = await events(streamWithFailover(attempts));
    expect(started).toBe(12);
    expect(output[output.length - 1]).toMatchObject({
      error: "Dhwani could not complete this reply. Please try again in a moment.",
      code: "AI_REQUEST_FAILED",
      done: true,
    });
  });

  it("reports an incomplete stream after text without switching models", async () => {
    let backupStarted = false;
    const output = await events(streamWithFailover([
      { label: "A", start: () => sse({ text: "Visible partial answer" }) },
      { label: "B", start: () => { backupStarted = true; return sse({ text: "Backup answer" }, { done: true }); } },
    ]));
    expect(output.map(item => item["text"]).filter(Boolean)).toEqual(["Visible partial answer"]);
    expect(output[output.length - 1]).toMatchObject({
      error: expect.stringContaining("before confirming"),
      code: "UPSTREAM_STREAM_INCOMPLETE",
      done: true,
    });
    expect(backupStarted).toBe(false);
  });

});