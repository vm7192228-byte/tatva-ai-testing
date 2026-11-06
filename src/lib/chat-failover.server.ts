/**
 * Provider failover for CodeForge SSE chat streams.
 * A backup is tried only before answer text reaches the user. Once text is
 * committed, the stream stays on that provider to avoid mixing model answers.
 */

export type FailoverAttempt = {
  label: string;
  start: () => Response;
  /** Shared/direct provider credentials are administrator-owned; retry upstream errors. */
  retryErrors?: boolean;
};

type ParsedFrame = { raw: string; data: Record<string, unknown> | null };
const MAX_ATTEMPTS = 12;

const TERMINAL_ERROR_CODES = new Set([
  "PRIVATE_GATEWAY_ACCESS_DENIED",
  "USER_AUTH_REQUIRED",
  "AUTH_REQUIRED",
  "SIGN_IN_REQUIRED",
  "USER_BANNED",
  "ACCOUNT_SUSPENDED",
  "USER_ACCESS_BLOCKED",
  "USER_DISABLED",
  "USER_PERMISSION_DENIED",
  "USER_RATE_LIMITED",
  "USER_QUOTA_EXCEEDED",
  "PLAN_LIMIT_REACHED",
  "UPSTREAM_CONTENT_FILTERED",
  "UPSTREAM_POLICY_DENIED",
]);

// Retry upstream provider failures before answer text is committed. User-level
// access/quota decisions and content-policy decisions remain terminal.
const RETRYABLE_UPSTREAM_CODES = new Set([
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_CONNECTION_FAILED",
  "UPSTREAM_STREAM_INTERRUPTED",
  "UPSTREAM_STREAM_FAILED",
  "UPSTREAM_STREAM_INCOMPLETE",
  "UPSTREAM_START_FAILED",
  "UPSTREAM_BAD_RESPONSE",
  "UPSTREAM_EMPTY_STREAM",
  "UPSTREAM_EMPTY_ANSWER",
  // Upstream quota, credential, billing, model and service errors are eligible
  // for the next route. User-level quotas and access denials use terminal codes.
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_AUTH_FAILED",
  "UPSTREAM_PERMISSION_DENIED",
  "UPSTREAM_BILLING_REQUIRED",
  "UPSTREAM_MODEL_NOT_FOUND",
  "UPSTREAM_PROVIDER_CONFIG_FAILED",
  "FREELLMAPI_QUOTA_EXHAUSTED",
  "UPSTREAM_TOOL_PROTOCOL_UNSUPPORTED",
  // An empty model catalog is local to this gateway. A different private
  // gateway may have an enabled provider/model, so continue the chain.
  "NO_PROVIDER_MODEL",
]);

function parseFrame(raw: string): ParsedFrame {
  const payload = raw.split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (!payload) return { raw, data: null };
  try {
    const value: unknown = JSON.parse(payload);
    return {
      raw,
      data: value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null,
    };
  } catch {
    return { raw, data: null };
  }
}

function errorFrame(message: string, code: string): string {
  return "data: " + JSON.stringify({ error: message, code, done: true });
}

export function streamWithFailover(
  attempts: FailoverAttempt[],
  cookies: string[] = [],
  clientSignal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const list = attempts.slice(0, MAX_ATTEMPTS);
  let closed = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abortListener: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sentFrames = new Set<string>();
      const write = (raw: string, dedupe: boolean) => {
        if (closed || !raw.trim()) return;
        if (dedupe) {
          if (sentFrames.has(raw)) return;
          sentFrames.add(raw);
        }
        try {
          controller.enqueue(encoder.encode(raw + "\n\n"));
        } catch {
          closed = true;
        }
      };
      const emit = (payload: Record<string, unknown>) => {
        write("data: " + JSON.stringify(payload), false);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (abortListener) clientSignal?.removeEventListener("abort", abortListener);
        try { controller.close(); } catch { /* The downstream client may have left. */ }
      };
      const onAbort = () => {
        void activeReader?.cancel(clientSignal?.reason).catch(() => undefined);
        activeReader = undefined;
        close();
      };
      abortListener = onAbort;

      if (clientSignal?.aborted) {
        onAbort();
        return;
      }
      clientSignal?.addEventListener("abort", onAbort, { once: true });

      void (async () => {
        let lastErrorFrame: string | undefined;
        let onlyCatalogEmptyFailures = true;
        for (let index = 0; index < list.length && !closed; index += 1) {
          const attempt = list[index]!;
          if (index > 0) {
            emit({
              activity: {
                id: "provider-failover",
                label: "Switching to a backup AI service",
                detail: "The current service could not start the answer, so another available service is being tried.",
                state: "active",
              },
            });
            emit({ status: "retrying", message: "Trying another available AI service…" });
          }

          let response: Response;
          try {
            response = attempt.start();
          } catch {
            onlyCatalogEmptyFailures = false;
            lastErrorFrame = errorFrame("The AI service could not start this request.", "UPSTREAM_START_FAILED");
            continue;
          }
          if (closed) return;

          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          if (!response.ok || !contentType.includes("text/event-stream")) {
            onlyCatalogEmptyFailures = false;
            try { await response.body?.cancel(); } catch { /* Do not expose upstream response bodies. */ }
            lastErrorFrame = errorFrame(
              "The AI service returned an unexpected response. Please try again.",
              "UPSTREAM_BAD_RESPONSE",
            );
            continue;
          }
          if (!response.body) {
            onlyCatalogEmptyFailures = false;
            lastErrorFrame = errorFrame("The AI service returned no response stream.", "UPSTREAM_EMPTY_STREAM");
            continue;
          }

          const reader = response.body.getReader();
          activeReader = reader;
          const decoder = new TextDecoder();
          let buffer = "";
          let committed = false;
          let terminalFrameSeen = false;
          let failed = false;

          const handle = (raw: string): "continue" | "stop" => {
            const frame = parseFrame(raw);
            const data = frame.data;
            const hasText = typeof data?.["text"] === "string" && data["text"].length > 0;
            const hasError = data !== null && data["error"] !== undefined && data["error"] !== null;
            if (data?.["done"] === true) terminalFrameSeen = true;

            if (committed) {
              if (hasError) {
                console.warn("[Tatv AI] provider stream failed after response commitment", {
                  provider: attempt.label,
                  code: typeof data?.["code"] === "string" ? data["code"] : "UPSTREAM_ERROR",
                });
                write(errorFrame(
                  "Tatv could not complete this reply. Please try again in a moment.",
                  "AI_REQUEST_FAILED",
                ), false);
                terminalFrameSeen = true;
              } else {
                write(raw, false);
              }
              return "continue";
            }

            // Once a tool begins, its execution may have side effects (for example,
            // creating a durable user approval). Do not replay the request on another
            // provider even when no answer text has reached the browser yet.
            const activity = data?.["activity"];
            const toolExecutionStarted = Boolean(
              activity && typeof activity === "object" && !Array.isArray(activity) &&
              typeof (activity as Record<string, unknown>)["id"] === "string" &&
              ((activity as Record<string, unknown>)["id"] as string).startsWith("tool-")
            );
            const approvalCreated = Boolean(
              data?.["approvalRequired"] && typeof data["approvalRequired"] === "object" &&
              !Array.isArray(data["approvalRequired"])
            );
            if (toolExecutionStarted || approvalCreated) {
              committed = true;
              write(raw, false);
              return "continue";
            }
            if (hasText) {
              committed = true;
              write(raw, false);
              return "continue";
            }
            if (hasError) {
              lastErrorFrame = raw;
              const code = typeof data?.["code"] === "string" ? data["code"] : "";
              const shouldRetry = !TERMINAL_ERROR_CODES.has(code) && (
                attempt.retryErrors === true || RETRYABLE_UPSTREAM_CODES.has(code)
              );
              if (shouldRetry) {
                console.warn("[Tatv AI] retrying next provider after upstream failure", {
                  provider: attempt.label,
                  code: code || "UPSTREAM_ERROR",
                });
                if (code !== "NO_PROVIDER_MODEL") onlyCatalogEmptyFailures = false;
                failed = true;
                return "stop";
              }
              // Do not bypass authentication, permission, billing, invalid-model,
              // or provider-policy failures. Keep diagnostics in server logs and
              // return only a neutral error to the user.
              console.warn("[Tatv AI] provider attempt ended without failover", {
                provider: attempt.label,
                code: typeof data?.["code"] === "string" ? data["code"] : "UPSTREAM_ERROR",
              });
              committed = true;
              write(errorFrame(
                "Tatv could not complete this reply. Please try again in a moment.",
                "AI_REQUEST_FAILED",
              ), false);
              terminalFrameSeen = true;
              return "continue";
            }
            if (data?.["done"] === true) {
              onlyCatalogEmptyFailures = false;
              lastErrorFrame = errorFrame(
                "The AI service finished without producing an answer. Please try again.",
                "UPSTREAM_EMPTY_ANSWER",
              );
              failed = true;
              return "stop";
            }
            write(raw, true);
            return "continue";
          };

          try {
            read: for (;;) {
              if (closed) break;
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let boundary = buffer.search(/\r?\n\r?\n/);
              while (boundary !== -1) {
                const separator = /^\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0].length ?? 2;
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + separator);
                if (raw.trim() && handle(raw) === "stop") break read;
                boundary = buffer.search(/\r?\n\r?\n/);
              }
            }
            buffer += decoder.decode();
            if (!closed && buffer.trim() && !failed) handle(buffer);
          } catch {
            if (closed) return;
            if (!committed) {
              onlyCatalogEmptyFailures = false;
              failed = true;
              lastErrorFrame = errorFrame(
                "The AI service stopped before starting an answer. Trying an available backup.",
                "UPSTREAM_STREAM_INTERRUPTED",
              );
            } else {
              emit({
                error: "The connection to the AI service was interrupted. Please retry the incomplete answer.",
                code: "UPSTREAM_STREAM_INTERRUPTED",
                done: true,
              });
              terminalFrameSeen = true;
            }
          }

          if (closed) return;
          if (failed) {
            try { await reader.cancel(); } catch { /* The provider stream may already be closed. */ }
            activeReader = undefined;
            continue;
          }
          if (!committed) {
            activeReader = undefined;
            if (!lastErrorFrame) onlyCatalogEmptyFailures = false;
            lastErrorFrame ??= errorFrame(
              "The AI service closed without producing an answer.",
              "UPSTREAM_EMPTY_ANSWER",
            );
            continue;
          }
          if (!terminalFrameSeen) {
            emit({
              error: "The AI service closed before confirming that its answer was complete. Please retry the incomplete answer.",
              code: "UPSTREAM_STREAM_INCOMPLETE",
              done: true,
            });
          }
          activeReader = undefined;
          close();
          return;
        }

        if (!closed) {
          // Keep the failure category in server logs for the future admin panel.
          // End users always receive the same neutral message, never provider or
          // gateway configuration details.
          const failureCode = onlyCatalogEmptyFailures && lastErrorFrame
            ? "NO_PROVIDER_MODEL"
            : lastErrorFrame ? "ALL_PROVIDERS_FAILED" : "PROVIDER_NOT_CONFIGURED";
          console.warn("[Tatv AI] provider chain exhausted", {
            attempts: list.length,
            failureCode,
          });
          emit({
            error: "Tatv could not complete this reply. Please try again in a moment.",
            code: "AI_REQUEST_FAILED",
            done: true,
          });
          close();
        }
      })().catch(() => {
        emit({ error: "The AI service hit an unexpected server error. Please retry your message.", done: true });
        close();
      });
    },
    cancel(reason) {
      closed = true;
      if (abortListener) clientSignal?.removeEventListener("abort", abortListener);
      void activeReader?.cancel(reason).catch(() => undefined);
      activeReader = undefined;
    },
  });

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-content-type-options": "nosniff",
    "x-accel-buffering": "no",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(stream, { status: 200, headers });
}