import { getAuthenticatedSession } from "./auth-api.server";

type RuntimeEnv = Record<string, unknown>;
type GenerationStatus =
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ChatGenerationRecord = {
  id: string;
  user_id: string;
  conversation_id: string;
  idempotency_key: string;
  provider: string;
  provider_started_at?: string | null;
  status: GenerationStatus;
  last_event_seq: number;
  status_message?: string | null;
  created_at?: string;
  expires_at: string;
};

type ChatGenerationEvent = {
  generation_id: string;
  user_id: string;
  seq: number;
  payload: Record<string, unknown>;
  created_at: string;
};

type ExecutionContextLike = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const bindings = runtimeEnv && typeof runtimeEnv === "object" ? runtimeEnv as RuntimeEnv : {};
  const configured = bindings[name];
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  const fallback = processLike?.env?.[name];
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : undefined;
}

function serviceConfig(runtimeEnv: unknown): { baseUrl: string; serviceKey: string } | null {
  const baseUrl = envValue("SUPABASE_URL", runtimeEnv)?.replace(/\/$/, "");
  const serviceKey = envValue("SUPABASE_SERVICE_ROLE_KEY", runtimeEnv) ?? envValue("SUPABASE_SECRET_KEY", runtimeEnv);
  return baseUrl && serviceKey ? { baseUrl, serviceKey } : null;
}

function serviceHeaders(serviceKey: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    apikey: serviceKey,
    authorization: "Bearer " + serviceKey,
    "content-type": "application/json",
    ...extra,
  });
}

function json(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const ALLOWED_PROVIDERS = new Set([
  "smart", "gemini", "openai", "anthropic", "deepseek", "xai",
  "cloudflare", "pollinations", "freellmapi",
]);

async function readOwnedGeneration(
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
): Promise<ChatGenerationRecord | null> {
  const config = serviceConfig(runtimeEnv);
  if (!config) throw new Error("GENERATION_DATABASE_NOT_CONFIGURED");
  const url = config.baseUrl + "/rest/v1/cf_chat_generations" +
    "?id=eq." + encodeURIComponent(generationId) +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,user_id,conversation_id,idempotency_key,provider,provider_started_at,status,last_event_seq,status_message,expires_at&limit=1";
  const response = await fetch(url, {
    headers: serviceHeaders(config.serviceKey),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("GENERATION_STATUS_READ_FAILED");
  const rows = await response.json() as ChatGenerationRecord[];
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export type SavedChatTextMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Loads only a saved, owner-scoped text conversation for background chat execution.
 * File contents are intentionally excluded from durable workflow arguments/state.
 */
export async function getSavedTextMessagesForGeneration(
  runtimeEnv: unknown,
  userId: string,
  conversationId: string,
): Promise<SavedChatTextMessage[]> {
  const config = serviceConfig(runtimeEnv);
  if (!config) throw new Error("GENERATION_DATABASE_NOT_CONFIGURED");

  const url = config.baseUrl + "/rest/v1/conversations" +
    "?id=eq." + encodeURIComponent(conversationId) +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,messages&limit=1";
  const response = await fetch(url, {
    headers: serviceHeaders(config.serviceKey),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("GENERATION_CONVERSATION_READ_FAILED");

  const rows = await response.json() as Array<{ id?: unknown; messages?: unknown }>;
  const conversation = Array.isArray(rows) ? rows[0] : undefined;
  if (!conversation || conversation.id !== conversationId || !Array.isArray(conversation.messages)) {
    throw new Error("GENERATION_CONVERSATION_NOT_FOUND");
  }
  if (conversation.messages.length === 0 || conversation.messages.length > 200) {
    throw new Error("GENERATION_CONVERSATION_INVALID");
  }

  const messages: SavedChatTextMessage[] = [];
  let totalCharacters = 0;
  for (const item of conversation.messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("GENERATION_CONVERSATION_INVALID");
    }
    const value = item as { role?: unknown; content?: unknown; attachments?: unknown };
    if ((value.role !== "user" && value.role !== "assistant") ||
        typeof value.content !== "string" ||
        !value.content.trim() ||
        value.content.length > 5_000 ||
        (Array.isArray(value.attachments) && value.attachments.length > 0)) {
      throw new Error("GENERATION_CONVERSATION_INVALID");
    }
    totalCharacters += value.content.length;
    if (totalCharacters > 100_000) throw new Error("GENERATION_CONVERSATION_TOO_LARGE");
    messages.push({ role: value.role, content: value.content });
  }

  if (messages[messages.length - 1]?.role !== "user") {
    throw new Error("GENERATION_LAST_MESSAGE_INVALID");
  }
  return messages;
}

export async function getOwnedChatGeneration(
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
): Promise<ChatGenerationRecord | null> {
  return readOwnedGeneration(runtimeEnv, userId, generationId);
}

async function expireGenerationIfNeeded(
  runtimeEnv: unknown,
  userId: string,
  generation: ChatGenerationRecord,
): Promise<ChatGenerationRecord> {
  if (isTerminal(generation.status) || Date.parse(generation.expires_at) > Date.now()) {
    return generation;
  }
  try {
    const status = await finishChatGeneration(
      runtimeEnv,
      userId,
      generation.id,
      "expired",
      "This generation exceeded its recovery retention window.",
    );
    return { ...generation, status, status_message: "This saved response has expired." };
  } catch {
    // Do not expose stale running status as recoverable when its TTL has elapsed.
    return { ...generation, status: "expired", status_message: "This saved response has expired." };
  }
}

async function callGenerationRpc(
  runtimeEnv: unknown,
  functionName: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const config = serviceConfig(runtimeEnv);
  if (!config) throw new Error("GENERATION_DATABASE_NOT_CONFIGURED");
  const response = await fetch(config.baseUrl + "/rest/v1/rpc/" + functionName, {
    method: "POST",
    headers: serviceHeaders(config.serviceKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("GENERATION_RPC_FAILED");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GENERATION_RPC_INVALID_RESPONSE");
  }
  return payload as Record<string, unknown>;
}

export async function appendChatGenerationEvent(
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const result = await callGenerationRpc(runtimeEnv, "cf_append_chat_generation_event", {
    p_user_id: userId,
    p_generation_id: generationId,
    p_payload: payload,
  });
  if (result["ok"] !== true || typeof result["seq"] !== "number") {
    throw new Error(typeof result["error"] === "string" ? result["error"] : "GENERATION_EVENT_APPEND_FAILED");
  }
  return result["seq"];
}

export async function claimChatGenerationForProvider(
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
  conversationId: string,
  idempotencyKey: string,
  provider: string,
): Promise<boolean> {
  const result = await callGenerationRpc(runtimeEnv, "cf_claim_chat_generation", {
    p_user_id: userId,
    p_generation_id: generationId,
    p_conversation_id: conversationId,
    p_idempotency_key: idempotencyKey,
    p_provider: provider,
  });
  return result["ok"] === true && result["claimed"] === true;
}

export async function finishChatGeneration(
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
  status: "completed" | "failed" | "cancelled" | "expired",
  statusMessage?: string,
): Promise<GenerationStatus> {
  const args = {
    p_user_id: userId,
    p_generation_id: generationId,
    p_status: status,
    p_status_message: statusMessage ?? null,
  };
  let result: Record<string, unknown>;
  try {
    result = await callGenerationRpc(runtimeEnv, "cf_finish_chat_generation", args);
  } catch {
    // The RPC is idempotent. Retry once if the first response timed out after commit.
    result = await callGenerationRpc(runtimeEnv, "cf_finish_chat_generation", args);
  }
  if (result["ok"] !== true || typeof result["status"] !== "string") {
    throw new Error(typeof result["error"] === "string" ? result["error"] : "GENERATION_FINALIZE_FAILED");
  }
  return result["status"] as GenerationStatus;
}

async function requestGenerationCancel(
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
): Promise<GenerationStatus> {
  const result = await callGenerationRpc(runtimeEnv, "cf_request_chat_generation_cancel", {
    p_user_id: userId,
    p_generation_id: generationId,
  });
  if (result["ok"] !== true || typeof result["status"] !== "string") {
    throw new Error(typeof result["error"] === "string" ? result["error"] : "GENERATION_CANCEL_FAILED");
  }
  return result["status"] as GenerationStatus;
}

function parseSsePayload(frame: string): Record<string, unknown> | null {
  const data = frame.split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const payload: unknown = JSON.parse(data);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isTerminal(status: GenerationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "expired";
}

/**
 * Persists each Tatv SSE envelope before it is delivered to the browser.
 * On a browser disconnect, the pump deliberately keeps consuming the upstream
 * stream; ExecutionContext.waitUntil keeps the task alive on supported workers.
 */
export async function persistChatGenerationStream(
  response: Response,
  runtimeEnv: unknown,
  userId: string,
  generationId: string,
  generationAbort: AbortController,
  executionContext?: unknown,
): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    // This request is still in the foreground. Await the terminal transition so
    // a serverless runtime cannot discard the generation failure update.
    await finishChatGeneration(runtimeEnv, userId, generationId, "failed", "The provider did not start a stream.");
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let connected = true;
  let finished = false;

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.set("x-codeforge-generation-id", generationId);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (value: Uint8Array) => {
        if (!connected) return;
        try { controller.enqueue(value); }
        catch { connected = false; }
      };

      const pump = async () => {
        let buffer = "";
        let pendingRead = reader.read();
        let upstreamEnded = false;
        let sawDone = false;
        let sawError = false;
        let cancelRequested = false;
        let statusReadFailures = 0;
        let terminalStatus: GenerationStatus | null = null;

        const persistFrame = async (frame: string) => {
          const payload = parseSsePayload(frame);
          if (!payload) {
            // Preserve non-JSON comments/heartbeats for the active response.
            if (connected && frame.trim()) enqueue(new TextEncoder().encode(frame + "\n\n"));
            return;
          }
          if (payload["done"] === true) sawDone = true;
          if (payload["error"] !== undefined && payload["error"] !== null && payload["error"] !== "") sawError = true;
          let seq: number;
          try {
            seq = await appendChatGenerationEvent(runtimeEnv, userId, generationId, payload);
          } catch (error) {
            const current = await readOwnedGeneration(runtimeEnv, userId, generationId).catch(() => null);
            if (current?.status === "cancel_requested" || current?.status === "cancelled") {
              cancelRequested = true;
              generationAbort.abort(new DOMException("Generation cancelled by the account owner.", "AbortError"));
              return;
            }
            if (current && isTerminal(current.status)) {
              terminalStatus = current.status;
              generationAbort.abort(new DOMException("Generation already reached a terminal state.", "AbortError"));
              return;
            }
            if (current && Date.parse(current.expires_at) <= Date.now()) {
              terminalStatus = "expired";
              generationAbort.abort(new DOMException("Generation expired.", "AbortError"));
              return;
            }
            throw error;
          }
          enqueue(new TextEncoder().encode("id: " + seq + "\ndata: " + JSON.stringify(payload) + "\n\n"));
        };

        try {
          while (!finished) {
            const outcome = await new Promise<
              { kind: "read"; result: ReadableStreamReadResult<Uint8Array> } | { kind: "poll" }
            >((resolve, reject) => {
              const pollTimer = setTimeout(() => resolve({ kind: "poll" }), 1_500);
              pendingRead.then(
                result => {
                  clearTimeout(pollTimer);
                  resolve({ kind: "read", result });
                },
                error => {
                  clearTimeout(pollTimer);
                  reject(error);
                },
              );
            });

            if (outcome.kind === "poll") {
              try {
                const generation = await readOwnedGeneration(runtimeEnv, userId, generationId);
                statusReadFailures = 0;
                if (!generation) {
                  generationAbort.abort(new DOMException("The generation record is no longer available.", "AbortError"));
                  terminalStatus = "failed";
                  break;
                }
                if (generation.status === "cancel_requested" || generation.status === "cancelled") {
                  cancelRequested = true;
                  generationAbort.abort(new DOMException("Generation cancelled by the account owner.", "AbortError"));
                  break;
                } else if (isTerminal(generation.status)) {
                  terminalStatus = generation.status;
                  break;
                } else if (Date.parse(generation.expires_at) <= Date.now()) {
                  terminalStatus = "expired";
                  generationAbort.abort(new DOMException("Generation expired.", "AbortError"));
                  break;
                }
              } catch {
                statusReadFailures += 1;
                if (statusReadFailures >= 4) {
                  generationAbort.abort(new DOMException("The durable generation status could not be verified.", "AbortError"));
                  terminalStatus = "failed";
                  break;
                }
              }
              continue;
            }

            const result = outcome.result;
            if (result.done) {
              upstreamEnded = true;
              buffer += decoder.decode();
              if (buffer.trim()) await persistFrame(buffer);
              break;
            }

            buffer += decoder.decode(result.value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              await persistFrame(frame);
              if (terminalStatus || cancelRequested) break;
            }
            if (terminalStatus || cancelRequested) break;
            pendingRead = reader.read();
          }

          // A terminal database state must stop upstream consumption as well.
          // AbortSignal is advisory for providers; cancel the response reader so
          // a stalled or non-cooperative stream cannot remain open in the worker.
          if (!upstreamEnded && (terminalStatus || cancelRequested)) {
            try { await reader.cancel("Durable generation reached a terminal state."); }
            catch { /* The provider stream may already have closed. */ }
          }

          if (cancelRequested) {
            terminalStatus = "cancelled";
            const cancelledPayload = {
              error: "Generation stopped by the account owner.",
              code: "GENERATION_CANCELLED",
              cancelled: true,
              done: true,
            };
            if (connected) {
              try { enqueue(new TextEncoder().encode("data: " + JSON.stringify(cancelledPayload) + "\n\n")); }
              catch { /* The client may already be disconnected. */ }
            }
          } else if (!terminalStatus) {
            terminalStatus = sawDone && !sawError ? "completed" : "failed";
          }

          if (terminalStatus !== "completed" && terminalStatus !== "cancelled" && !sawDone) {
            const message = terminalStatus === "expired"
              ? "This generation expired before it could finish."
              : "The connection to the AI provider ended before completion was confirmed.";
            const errorPayload = {
              error: message,
              code: terminalStatus === "expired" ? "GENERATION_EXPIRED" : "GENERATION_INTERRUPTED",
              done: true,
            };
            try {
              const seq = await appendChatGenerationEvent(runtimeEnv, userId, generationId, errorPayload);
              enqueue(new TextEncoder().encode("id: " + seq + "\ndata: " + JSON.stringify(errorPayload) + "\n\n"));
              sawDone = true;
              sawError = true;
            } catch {
              // The finish RPC below still provides the terminal state when available.
            }
          }

          const statusMessage = terminalStatus === "failed"
            ? (sawError ? "The provider returned an error." : "The provider stream ended before completion.")
            : terminalStatus === "cancelled" ? "Cancelled by the account owner."
              : terminalStatus === "expired" ? "This generation expired before it could finish." : undefined;
          try {
            const finalStatus = await finishChatGeneration(
              runtimeEnv,
              userId,
              generationId,
              terminalStatus === "completed" ? "completed"
                : terminalStatus === "cancelled" ? "cancelled"
                : terminalStatus === "expired" ? "expired" : "failed",
              statusMessage,
            );
            if (finalStatus === "cancelled") terminalStatus = "cancelled";
          } catch {
            console.error("[Tatv AI] Durable generation finalization was not confirmed.");
          }
        } catch (error) {
          generationAbort.abort(error);
          if (cancelRequested) {
            const cancelledPayload = {
              error: "Generation stopped by the account owner.",
              code: "GENERATION_CANCELLED",
              cancelled: true,
              done: true,
            };
            if (connected) {
              try { enqueue(new TextEncoder().encode("data: " + JSON.stringify(cancelledPayload) + "\n\n")); }
              catch { /* The client may already be disconnected. */ }
            }
            try {
              await finishChatGeneration(runtimeEnv, userId, generationId, "cancelled", "Cancelled by the account owner.");
            } catch {
              console.error("[Tatv AI] Durable cancellation state could not be saved.");
            }
          } else {
            const payload = {
              error: "The response could not be saved for reconnect. Please retry the request.",
              code: "GENERATION_PERSIST_FAILED",
              done: true,
            };
            if (connected) {
              try { enqueue(new TextEncoder().encode("data: " + JSON.stringify(payload) + "\n\n")); }
              catch { /* The client may have disconnected. */ }
            }
            try {
              await finishChatGeneration(runtimeEnv, userId, generationId, "failed", "Event persistence failed.");
            } catch {
              console.error("[Tatv AI] Durable generation failure state could not be saved.");
            }
          }
        } finally {
          finished = true;
          if (connected) {
            try { controller.close(); } catch { /* The client may already be gone. */ }
          }
        }
      };

      const pumpPromise = pump();
      const waitUntil = (executionContext as ExecutionContextLike | undefined)?.waitUntil;
      if (typeof waitUntil === "function") {
        try { waitUntil.call(executionContext, pumpPromise); }
        catch { console.error("[Tatv AI] The runtime did not accept the background generation task."); }
      }
    },
    cancel() {
      // Do not cancel the provider reader: the background pump must continue
      // persisting events after a transient browser disconnect.
      connected = false;
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleChatGenerationsApiRequest(
  request: Request,
  runtimeEnv: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/chat/generations") {
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "METHOD_NOT_ALLOWED", message: "Use GET to find the latest generation or POST to start one." }, 405);
    }
    if (request.method === "POST" && !sameOrigin(request)) {
      return json({ error: "ORIGIN_NOT_ALLOWED", message: "This request origin is not allowed." }, 403);
    }

    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503, session.cookies);
    if (!session.user || !session.accessToken) {
      return json({ error: "AUTH_REQUIRED", message: "Sign in to enable chat recovery across reconnects." }, 401, session.cookies);
    }
    const config = serviceConfig(runtimeEnv);
    if (!config) {
      return json({ error: "GENERATION_DATABASE_NOT_CONFIGURED", message: "Durable chat recovery is not available on this deployment yet." }, 503, session.cookies);
    }

    if (request.method === "GET") {
      const conversationId = url.searchParams.get("conversationId") || "";
      if (!isUuid(conversationId)) {
        return json({ error: "INVALID_CONVERSATION_ID", message: "A valid conversation ID is required." }, 400, session.cookies);
      }
      try {
        const conversationUrl = config.baseUrl + "/rest/v1/conversations" +
          "?id=eq." + encodeURIComponent(conversationId) +
          "&user_id=eq." + encodeURIComponent(session.user.id) +
          "&select=id,updated_at&limit=1";
        const conversationResponse = await fetch(conversationUrl, {
          headers: serviceHeaders(config.serviceKey),
          signal: AbortSignal.timeout(8_000),
        });
        if (!conversationResponse.ok) {
          return json({ error: "CONVERSATION_LOOKUP_FAILED", message: "The saved conversation could not be verified." }, 502, session.cookies);
        }
        const conversationRows = await conversationResponse.json() as Array<{ id: string; updated_at?: string | null }>;
        const savedConversation = Array.isArray(conversationRows) ? conversationRows[0] : undefined;
        if (!savedConversation) {
          return json({ ok: true, generation: null }, 200, session.cookies);
        }
        const conversationUpdatedAt = Date.parse(savedConversation.updated_at || "");

        const lookupUrl = config.baseUrl + "/rest/v1/cf_chat_generations" +
          "?conversation_id=eq." + encodeURIComponent(conversationId) +
          "&user_id=eq." + encodeURIComponent(session.user.id) +
          "&select=id,user_id,conversation_id,idempotency_key,provider,status,last_event_seq,status_message,created_at,expires_at&order=created_at.desc&limit=1";
        const lookup = await fetch(lookupUrl, {
          headers: serviceHeaders(config.serviceKey),
          signal: AbortSignal.timeout(8_000),
        });
        if (!lookup.ok) return json({ error: "GENERATION_LOOKUP_FAILED", message: "The latest chat generation could not be found." }, 502, session.cookies);
        const rows = await lookup.json() as ChatGenerationRecord[];
        let generation = Array.isArray(rows) ? rows[0] : undefined;
        // If generation creation failed and normal chat fell back, do not replay
        // an older generation from this conversation as the answer to the new turn.
        if (generation && Number.isFinite(conversationUpdatedAt) &&
            typeof generation.created_at === "string" &&
            Date.parse(generation.created_at) < conversationUpdatedAt) {
          generation = undefined;
        }
        if (generation) generation = await expireGenerationIfNeeded(runtimeEnv, session.user.id, generation);
        return json({
          ok: true,
          generation: generation ? {
            id: generation.id,
            status: generation.status,
            lastEventSeq: generation.last_event_seq,
            statusMessage: generation.status_message ?? null,
          } : null,
        }, 200, session.cookies);
      } catch {
        return json({ error: "GENERATION_DATABASE_UNAVAILABLE", message: "Could not reach the generation database." }, 502, session.cookies);
      }
    }

    const idempotencyKey = request.headers.get("idempotency-key") || "";
    if (!isUuid(idempotencyKey)) {
      return json({ error: "INVALID_IDEMPOTENCY_KEY", message: "A valid idempotency key is required." }, 400, session.cookies);
    }

    let payload: { conversationId?: unknown; provider?: unknown };
    try {
      payload = await request.json() as typeof payload;
    } catch {
      return json({ error: "INVALID_JSON", message: "Send valid JSON generation details." }, 400, session.cookies);
    }
    if (!isUuid(payload.conversationId) || typeof payload.provider !== "string" || !ALLOWED_PROVIDERS.has(payload.provider)) {
      return json({ error: "INVALID_GENERATION", message: "The conversation or provider selection is invalid." }, 400, session.cookies);
    }

    // Only attach a durable generation to a conversation that is already saved
    // by this same authenticated owner. This prevents orphaned and cross-owner IDs.
    try {
      const conversationUrl = config.baseUrl + "/rest/v1/conversations" +
        "?id=eq." + encodeURIComponent(payload.conversationId) +
        "&user_id=eq." + encodeURIComponent(session.user.id) +
        "&select=id&limit=1";
      const conversationResponse = await fetch(conversationUrl, {
        headers: serviceHeaders(config.serviceKey),
        signal: AbortSignal.timeout(8_000),
      });
      if (!conversationResponse.ok) {
        return json({ error: "CONVERSATION_VERIFY_FAILED", message: "Tatv could not verify that this saved conversation belongs to your account." }, 503, session.cookies);
      }
      const ownedConversations = await conversationResponse.json() as Array<{ id?: string }>;
      if (!Array.isArray(ownedConversations) || ownedConversations.length === 0) {
        return json({ error: "CONVERSATION_NOT_FOUND", message: "Save this conversation before starting durable recovery." }, 404, session.cookies);
      }
    } catch {
      return json({ error: "CONVERSATION_DATABASE_UNAVAILABLE", message: "The saved conversation could not be verified. Normal chat remains available." }, 503, session.cookies);
    }

    const generationId = crypto.randomUUID();
    try {
      const response = await fetch(config.baseUrl + "/rest/v1/rpc/cf_create_chat_generation", {
        method: "POST",
        headers: serviceHeaders(config.serviceKey),
        body: JSON.stringify({
          p_user_id: session.user.id,
          p_generation_id: generationId,
          p_conversation_id: payload.conversationId,
          p_idempotency_key: idempotencyKey,
          p_provider: payload.provider,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        return json({ error: "GENERATION_CREATE_FAILED", message: "A durable generation could not be started. Standard chat remains available." }, 503, session.cookies);
      }
      const result = await response.json() as Record<string, unknown>;
      if (result["ok"] !== true) {
        if (result["error"] === "RATE_LIMITED") {
          return json({ error: "GENERATION_RATE_LIMITED", message: "Too many durable chat requests were started recently. Please wait a little before sending another." }, 429, session.cookies);
        }
        if (result["error"] === "TOO_MANY_ACTIVE_GENERATIONS") {
          return json({ error: "ACTIVE_GENERATION_LIMIT", message: "You already have several chat responses running. Stop or finish one before starting another." }, 429, session.cookies);
        }
        return json({ error: "GENERATION_CREATE_FAILED", message: "A durable generation could not be started. Standard chat remains available." }, 503, session.cookies);
      }
      if (typeof result["generationId"] !== "string") {
        return json({ error: "GENERATION_CREATE_FAILED", message: "A durable generation could not be started. Standard chat remains available." }, 503, session.cookies);
      }
      if (result["conversationId"] !== payload.conversationId || result["provider"] !== payload.provider) {
        return json({ error: "IDEMPOTENCY_KEY_REUSED", message: "This request key belongs to a different conversation or provider. Start a new message to create a fresh request." }, 409, session.cookies);
      }
      return json({
        ok: true,
        generationId: result["generationId"],
        status: result["status"],
        lastEventSeq: result["lastEventSeq"] ?? 0,
        existing: result["existing"] === true,
      }, 201, session.cookies);
    } catch {
      return json({ error: "GENERATION_DATABASE_UNAVAILABLE", message: "Durable recovery could not be reached. Standard chat remains available." }, 503, session.cookies);
    }
  }

  const match = url.pathname.match(/^\/api\/chat\/generations\/([0-9a-f-]{36})(?:\/(events|cancel|fail))?$/i);
  if (!match) return null;
  const generationId = match[1];
  const action = match[2] ?? "status";
  if (!isUuid(generationId)) {
    return json({ error: "INVALID_GENERATION_ID", message: "A valid generation ID is required." }, 400);
  }

  const session = await getAuthenticatedSession(request, runtimeEnv);
  if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503, session.cookies);
  if (!session.user || !session.accessToken) {
    return json({ error: "AUTH_REQUIRED", message: "Sign in to access this saved generation." }, 401, session.cookies);
  }
  if ((request.method === "POST" || request.method === "DELETE") && !sameOrigin(request)) {
    return json({ error: "ORIGIN_NOT_ALLOWED", message: "This request origin is not allowed." }, 403, session.cookies);
  }

  try {
    let generation = await readOwnedGeneration(runtimeEnv, session.user.id, generationId);
    if (!generation) {
      return json({ error: "GENERATION_NOT_FOUND", message: "This generation was not found or is not available to this account." }, 404, session.cookies);
    }
    generation = await expireGenerationIfNeeded(runtimeEnv, session.user.id, generation);

    if (action === "events" && request.method === "GET") {
      const rawAfter = Number(url.searchParams.get("after") || 0);
      const after = Number.isSafeInteger(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
      const config = serviceConfig(runtimeEnv);
      if (!config) return json({ error: "GENERATION_DATABASE_NOT_CONFIGURED", message: "Generation history is temporarily unavailable." }, 503, session.cookies);
      const eventUrl = config.baseUrl + "/rest/v1/cf_chat_generation_events" +
        "?generation_id=eq." + encodeURIComponent(generationId) +
        "&user_id=eq." + encodeURIComponent(session.user.id) +
        "&seq=gt." + after +
        "&select=seq,payload,created_at&order=seq.asc&limit=100";
      const eventResponse = await fetch(eventUrl, {
        headers: serviceHeaders(config.serviceKey),
        signal: AbortSignal.timeout(8_000),
      });
      if (!eventResponse.ok) return json({ error: "GENERATION_EVENTS_LOAD_FAILED", message: "Saved response events could not be loaded." }, 502, session.cookies);
      const events = await eventResponse.json() as ChatGenerationEvent[];
      return json({
        ok: true,
        generation: {
          id: generation.id,
          status: generation.status,
          lastEventSeq: generation.last_event_seq,
          statusMessage: generation.status_message ?? null,
        },
        events: Array.isArray(events) ? events : [],
      }, 200, session.cookies);
    }

    if (action === "status" && request.method === "GET") {
      return json({
        ok: true,
        generation: {
          id: generation.id,
          status: generation.status,
          lastEventSeq: generation.last_event_seq,
          statusMessage: generation.status_message ?? null,
        },
      }, 200, session.cookies);
    }

    if (action === "cancel" && request.method === "POST") {
      // The RPC atomically moves running generations to terminal cancelled and
      // appends the terminal event, including when the provider pump has not
      // started yet. Active pumps observe the state and abort their provider.
      const status = await requestGenerationCancel(runtimeEnv, session.user.id, generationId);
      return json({ ok: true, status }, 200, session.cookies);
    }

    if (action === "fail" && request.method === "POST") {
      if (generation.status !== "running") {
        return json({ ok: true, status: generation.status }, 200, session.cookies);
      }
      const status = await finishChatGeneration(runtimeEnv, session.user.id, generationId, "failed", "The chat request was rejected before streaming started.");
      return json({ ok: true, status }, 200, session.cookies);
    }

    return json({ error: "METHOD_NOT_ALLOWED", message: "The generation action or method is not supported." }, 405, session.cookies);
  } catch {
    return json({ error: "GENERATION_DATABASE_UNAVAILABLE", message: "Could not reach the generation database. Please retry." }, 502, session.cookies);
  }
}
