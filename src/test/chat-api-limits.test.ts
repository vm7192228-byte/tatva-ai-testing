import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { checkChatRateLimit, handleChatApiRequest, shouldUseVercelDurableWorkflow, validateMessages } from "@/lib/chat-api.server";
import { CHAT_LIMITS } from "@/lib/chat-limits";
import { codeforgeMarkup } from "@/lib/codeforge-markup";

function valid(messages: unknown[]) {
  const result = validateMessages(messages);
  if (!result.ok) throw new Error(result.message);
  return result.messages;
}

function invalid(messages: unknown[]) {
  const result = validateMessages(messages);
  if (result.ok) throw new Error("Expected validation to reject this request.");
  return result;
}

describe("shared browser and server limits", () => {
  it("publishes the server limits into the browser composer markup", () => {
    expect(codeforgeMarkup).toContain(`data-max-messages="${CHAT_LIMITS.messagesPerRequest}"`);
    expect(codeforgeMarkup).toContain(`data-max-message-chars="${CHAT_LIMITS.charactersPerMessage}"`);
    expect(codeforgeMarkup).toContain(`data-max-conversation-chars="${CHAT_LIMITS.charactersPerConversation}"`);
    expect(codeforgeMarkup).toContain(`data-max-attachments="${CHAT_LIMITS.attachmentCountPerMessage}"`);
    expect(codeforgeMarkup).toContain(`data-inline-attachment-bytes="${CHAT_LIMITS.inlineAttachmentBytes}"`);
    expect(codeforgeMarkup).toContain(`data-max-attachment-bytes="${CHAT_LIMITS.totalAttachmentBytes}"`);
  });
});

describe("durable workflow provider eligibility", () => {
  const eligibleRequest = {
    isVercel: true,
    workflowExecution: false,
    userId: "11111111-1111-4111-8111-111111111111",
    generationId: "22222222-2222-4222-8222-222222222222",
    disableDurableWorkflow: false,
    voiceMode: false,
    projectBundle: false,
    hasAttachments: false,
    isSocialAnalysis: false,
  };

  it("keeps Tatv Smart on the authenticated browser request path", () => {
    expect(shouldUseVercelDurableWorkflow({
      ...eligibleRequest,
      provider: "smart",
    })).toBe(false);
  });

  it("allows token-independent providers to use the durable workflow", () => {
    expect(shouldUseVercelDurableWorkflow({
      ...eligibleRequest,
      provider: "gemini",
    })).toBe(true);
  });

  it("keeps the durable workflow disabled for specialised chat paths", () => {
    expect(shouldUseVercelDurableWorkflow({
      ...eligibleRequest,
      provider: "gemini",
      hasAttachments: true,
    })).toBe(false);
    expect(shouldUseVercelDurableWorkflow({
      ...eligibleRequest,
      provider: "gemini",
      isSocialAnalysis: true,
    })).toBe(false);
  });
});

describe("chat request boundaries", () => {
  it("accepts an ordinary 1,800-character message", () => {
    expect(valid([{ role: "user", content: "a".repeat(1_800) }])).toHaveLength(1);
  });

  it("accepts a message at the configured 5,000-character boundary", () => {
    expect(valid([{ role: "user", content: "a".repeat(5_000) }])).toHaveLength(1);
  });

  it("returns the exact per-message character limit when it is exceeded", () => {
    const result = invalid([{ role: "user", content: "a".repeat(5_001) }]);

    expect(result.error).toBe("MESSAGE_TOO_LONG");
    expect(result.limit).toBe(5_000);
    expect(result.actual).toBe(5_001);
    expect(result.message).toContain("5,001");
    expect(result.message).toContain("5,000");
  });

  it("counts Unicode code points consistently at the message boundary", () => {
    expect(valid([{ role: "user", content: "😀".repeat(5_000) }])).toHaveLength(1);
  });

  it("reports Unicode code-point counts rather than UTF-16 code units", () => {
    const result = invalid([{ role: "user", content: "😀".repeat(5_001) }]);

    expect(result.error).toBe("MESSAGE_TOO_LONG");
    expect(result.limit).toBe(5_000);
    expect(result.actual).toBe(5_001);
  });

  it("accepts the documented 60-message conversation boundary", () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: index === 59 ? "user" : index % 2 === 0 ? "user" : "assistant",
      content: "message " + index,
    }));

    expect(valid(messages)).toHaveLength(60);
  });

  it("reports the actual 60-message limit rather than a stale 20-message limit", () => {
    const messages = Array.from({ length: 61 }, (_, index) => ({
      role: index === 60 ? "user" : index % 2 === 0 ? "user" : "assistant",
      content: "message " + index,
    }));
    const result = invalid(messages);

    expect(result.error).toBe("MESSAGE_COUNT_LIMIT");
    expect(result.limit).toBe(60);
    expect(result.actual).toBe(61);
    expect(result.message).toContain("60 messages");
  });

  it("enforces the combined conversation and extracted-file text limit", () => {
    const messages = Array.from({ length: 13 }, (_, index) => ({
      role: index === 12 ? "user" : index % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(5_000),
    }));
    const result = invalid(messages);

    expect(result.error).toBe("CONVERSATION_TEXT_LIMIT");
    expect(result.limit).toBe(64_000);
    expect(result.actual).toBe(65_000);
  });

  it("preserves owner-scoped private storage references after validation", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const objectId = "22222222-2222-4222-8222-222222222222";
    const storagePath = userId + "/chat/" + objectId + ".pdf";
    const result = valid([{
      role: "user",
      content: "Please summarize this PDF.",
      attachments: [{
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 1024 * 1024,
        storagePath,
      }],
    }]);

    expect(result[0]?.attachments).toEqual([{
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1024 * 1024,
      storagePath,
    }]);
  });

  it("rejects malformed base64 attachment data before calling an AI provider", () => {
    const result = invalid([{
      role: "user",
      content: "Please inspect this image.",
      attachments: [{
        name: "image.png",
        mimeType: "image/png",
        size: 3,
        data: "AAAAA",
      }],
    }]);

    expect(result.error).toBe("INVALID_ATTACHMENT_DATA");
  });

  it("rejects public chat POSTs without Origin or same-origin Fetch Metadata", async () => {
    const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    }), {});

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    expect(await response!.json()).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
  });

  it("rejects cross-origin chat POSTs", async () => {
    const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    }), {});

    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("accepts trusted durable workflow execution without browser Origin headers", async () => {
    const messages = Array.from({ length: 61 }, (_, index) => ({
      role: index === 60 ? "user" : index % 2 === 0 ? "user" : "assistant",
      content: "message " + index,
    }));
    const response = await handleChatApiRequest(new Request("https://tatv.internal/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    }), {}, undefined, {
      workflowExecution: true,
      trustedUserId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(413);
    expect(await response!.json()).toMatchObject({ error: "MESSAGE_COUNT_LIMIT" });
  });

  it("returns the same actionable limit information through the chat API", async () => {
    const messages = Array.from({ length: 61 }, (_, index) => ({
      role: index === 60 ? "user" : index % 2 === 0 ? "user" : "assistant",
      content: "message " + index,
    }));
    const response = await handleChatApiRequest(new Request("https://codeforge.example/api/chat", {
      method: "POST",
      headers: { origin: "https://codeforge.example", "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    }), {});

    expect(response).not.toBeNull();
    expect(response!.status).toBe(413);
    const payload = await response!.json();
    expect(payload.error).toBe("MESSAGE_COUNT_LIMIT");
    expect(payload.limit).toBe(60);
    expect(payload.actual).toBe(61);
  });
});


describe("chat rate-limit store availability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails closed in production when the shared limiter is not configured", async () => {
    const result = await checkChatRateLimit(
      "user:production-missing-store",
      15,
      { NODE_ENV: "production" },
    );

    expect(result).toEqual({ allowed: false, retryAfter: 5, unavailable: true });
  });

  it("fails closed when the shared database is unavailable instead of falling back to an instance-local counter", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi.fn(async () => new Response("database unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkChatRateLimit(
      "user:production-database-outage",
      15,
      {
        NODE_ENV: "production",
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
      },
    );

    expect(result).toEqual({ allowed: false, retryAfter: 5, unavailable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps local development usable when no shared database is configured", async () => {
    const result = await checkChatRateLimit(
      "local-development-" + crypto.randomUUID(),
      6,
      { NODE_ENV: "development" },
    );

    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });
});
