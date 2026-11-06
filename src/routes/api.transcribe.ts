import { createHash } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedSession } from "../lib/auth-api.server";
import { readOwnedChatUpload } from "../lib/uploads-api.server";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_TRANSCRIPTION_REQUEST_BYTES = 4_000_000;
const TRANSCRIPTION_WINDOW_MS = 60_000;
const MAX_TRANSCRIPTIONS_PER_WINDOW = 10;

// Per-runtime backstop. A shared persistent quota is still needed for a strict
// deployment-wide limit across multiple serverless instances.
const transcriptionAttempts = new Map<string, { count: number; resetsAt: number }>();

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function allowTranscription(subject: string, limit: number): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  for (const [id, record] of transcriptionAttempts) {
    if (record.resetsAt <= now) transcriptionAttempts.delete(id);
  }

  const current = transcriptionAttempts.get(subject);
  if (!current) {
    transcriptionAttempts.set(subject, { count: 1, resetsAt: now + TRANSCRIPTION_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }

  current.count += 1;
  return {
    allowed: current.count <= limit,
    retryAfter: Math.max(1, Math.ceil((current.resetsAt - now) / 1_000)),
  };
}

function guestRateLimitKey(request: Request): string {
  // Hash the network identifier so raw IP addresses are not retained in memory.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = request.headers.get("x-real-ip")?.trim() || forwarded || "unknown";
  return "guest:" + createHash("sha256").update(address).digest("hex");
}

function envValue(name: string, context: unknown): string | undefined {
  const values = context && typeof context === "object" ? context as Record<string, unknown> : {};
  const direct = values[name];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = values["env"] && typeof values["env"] === "object"
    ? (values["env"] as Record<string, unknown>)[name]
    : undefined;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  const processLike = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const fromProcess = processLike?.env?.[name];
  return typeof fromProcess === "string" && fromProcess.trim() ? fromProcess.trim() : undefined;
}

async function reserveSharedTranscriptionAttempt(
  subject: string,
  limit: number,
  context: unknown,
): Promise<{ allowed: boolean; retryAfter: number } | null> {
  const baseUrl = envValue("SUPABASE_URL", context)?.replace(/\/$/, "");
  const serviceKey = envValue("SUPABASE_SERVICE_ROLE_KEY", context) ??
    envValue("SUPABASE_SECRET_KEY", context);
  if (!baseUrl && !serviceKey) return null;
  if (!baseUrl || !serviceKey) throw new Error("TRANSCRIPTION_RATE_LIMIT_NOT_CONFIGURED");

  const subjectHash = createHash("sha256").update(subject).digest("hex");
  const response = await fetch(baseUrl + "/rest/v1/rpc/cf_allow_transcription_attempt", {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: "Bearer " + serviceKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_subject_hash: subjectHash,
      p_max_attempts: limit,
      p_window_seconds: 60,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("TRANSCRIPTION_RATE_LIMIT_UNAVAILABLE");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("TRANSCRIPTION_RATE_LIMIT_INVALID_RESPONSE");
  }
  const result = payload as Record<string, unknown>;
  if (typeof result["allowed"] !== "boolean") {
    throw new Error("TRANSCRIPTION_RATE_LIMIT_INVALID_RESPONSE");
  }
  return {
    allowed: result["allowed"],
    retryAfter: typeof result["retryAfterSeconds"] === "number"
      ? Math.max(1, Math.ceil(result["retryAfterSeconds"]))
      : 1,
  };
}

function jsonResponse(data: unknown, init: ResponseInit = {}, cookies: string[] = []): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        let cookiesOut: string[] = [];
        const respond = (data: unknown, init: ResponseInit = {}) => jsonResponse(data, init, cookiesOut);

        if (!sameOrigin(request)) {
          return respond(
            { error: "ORIGIN_NOT_ALLOWED", message: "This request must come from the CodeForge website." },
            { status: 403 },
          );
        }

        // Vercel Functions reject request bodies above 4.5 MB before the route
        // can handle them. Reject oversized multipart audio early and leave room
        // for the multipart boundary and language fields.
        const declaredRequestBytes = Number(request.headers.get("content-length"));
        if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > MAX_TRANSCRIPTION_REQUEST_BYTES) {
          return respond(
            { error: "AUDIO_TOO_LARGE", message: "Keep each voice turn under 3 MB, then send it as a shorter recording." },
            { status: 413 },
          );
        }

        const session = await getAuthenticatedSession(request, context ?? process.env, 2_500);
        cookiesOut = session.cookies;
        if (session.unavailable) {
          return respond({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, { status: 503 });
        }

        // Authentication is optional for this endpoint because guest chat is
        // intentionally supported. Guest requests receive a tighter per-IP
        // limit; signed-in users keep the existing per-account limit.
        const isGuest = !session.configured || !session.user;
        const subject = isGuest ? guestRateLimitKey(request) : "user:" + session.user!.id;
        const limit = isGuest ? 15 : MAX_TRANSCRIPTIONS_PER_WINDOW;
        const localRate = allowTranscription(subject, limit);
        let rate = localRate;
        try {
          const sharedRate = await reserveSharedTranscriptionAttempt(subject, limit, context ?? process.env);
          if (sharedRate) {
            rate = {
              allowed: localRate.allowed && sharedRate.allowed,
              retryAfter: Math.max(localRate.retryAfter, sharedRate.retryAfter),
            };
          }
        } catch {
          // If Supabase is configured but its shared limiter is unavailable,
          // fail closed rather than silently downgrading to an instance-local cap.
          return respond(
            { error: "RATE_LIMIT_UNAVAILABLE", message: "Voice transcription is temporarily unavailable. Please retry shortly." },
            { status: 503 },
          );
        }
        if (!rate.allowed) {
          return respond(
            { error: "RATE_LIMITED", message: "Too many voice transcription requests. Please wait before speaking again." },
            { status: 429, headers: { "retry-after": String(rate.retryAfter) } },
          );
        }

        // Server-side transcription is opt-in. Do not silently route voice
        // audio through an unapproved model/provider.
        const transcriptionEnabled =
          envValue("POLLINATIONS_TRANSCRIPTION_ENABLED", context ?? process.env)?.toLowerCase() === "true";
        const apiKey = envValue("POLLINATIONS_API_KEY", context ?? process.env);

        let audioBytes: Uint8Array;
        let mimeType: string;
        let language: string;
        const requestContentType = (request.headers.get("content-type") ?? "").toLowerCase();

        if (requestContentType.includes("application/json")) {
          if (!session.user) {
            return respond(
              { error: "UPLOAD_AUTH_REQUIRED", message: "Sign in before transcribing a large voice recording." },
              { status: 401 },
            );
          }
          let payload: unknown;
          try { payload = await request.json(); }
          catch {
            return respond({ error: "INVALID_JSON", message: "The private voice-upload reference is invalid." }, { status: 400 });
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return respond({ error: "INVALID_JSON", message: "The private voice-upload reference is invalid." }, { status: 400 });
          }
          const record = payload as Record<string, unknown>;
          const storagePath = typeof record["storagePath"] === "string" ? record["storagePath"] : "";
          const reportedType = typeof record["mimeType"] === "string" ? record["mimeType"].split(";")[0]?.trim().toLowerCase() || "" : "";
          const reportedSize = typeof record["size"] === "number" ? record["size"] : Number(record["size"]);
          if (!Number.isSafeInteger(reportedSize) || reportedSize <= 0 || reportedSize > MAX_AUDIO_BYTES ||
              !["audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"].includes(reportedType)) {
            return respond({ error: "INVALID_AUDIO", message: "Choose an audio recording up to 10 MB." }, { status: 400 });
          }
          const stored = await readOwnedChatUpload(
            context ?? process.env,
            session.user.id,
            storagePath,
            reportedType,
            reportedSize,
            MAX_AUDIO_BYTES,
            request.signal,
          );
          if (!stored.ok) {
            return respond({ error: stored.error, message: stored.message }, { status: stored.status });
          }
          audioBytes = stored.bytes;
          mimeType = stored.mimeType;
          language = String(record["language"] || "auto").trim().toLowerCase();
        } else if (requestContentType.includes("multipart/form-data")) {
          let form: FormData;
          try {
            form = await request.formData();
          } catch {
            if (request.signal.aborted) {
              return respond({ error: "TRANSCRIPTION_CANCELLED", message: "The voice session was stopped." }, { status: 499 });
            }
            return respond({ message: "Send an audio recording to transcribe." }, { status: 400 });
          }

          const audioEntry = form.get("audio");
          // Avoid instanceof File so valid uploads work across JavaScript realms.
          if (
            !audioEntry ||
            typeof audioEntry === "string" ||
            typeof audioEntry.arrayBuffer !== "function" ||
            !Number.isFinite(audioEntry.size) ||
            audioEntry.size <= 0
          ) {
            return respond({ message: "The audio recording was empty." }, { status: 400 });
          }
          if (audioEntry.size > MAX_INLINE_AUDIO_BYTES) {
            return respond({
              error: "AUDIO_TOO_LARGE",
              message: "Guest and inline voice recordings must stay under 3 MB. Sign in to use secure direct uploads for larger recordings.",
            }, { status: 413 });
          }
          const reportedMimeType = audioEntry.type || "audio/webm";
          const baseMimeType = (reportedMimeType.split(";")[0] ?? "").trim().toLowerCase();
          mimeType = /^audio\/[a-z0-9.+-]+$/.test(baseMimeType) ? baseMimeType : "audio/webm";
          audioBytes = new Uint8Array(await audioEntry.arrayBuffer());
          language = String(form.get("language") || "auto").trim().toLowerCase();
        } else {
          return respond({ error: "UNSUPPORTED_CONTENT_TYPE", message: "Send audio using multipart form data or a signed private upload reference." }, { status: 415 });
        }

        if (request.signal.aborted) {
          return respond({ error: "TRANSCRIPTION_CANCELLED", message: "The voice session was stopped." }, { status: 499 });
        }

        // Gemini transcription is intentionally unavailable in this build.
        // Only the approved, explicitly enabled Pollinations route may transcribe audio.
        if (!transcriptionEnabled || !apiKey || !apiKey.startsWith("sk_")) {
          return respond(
            { error: "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED", message: "Voice transcription is not configured. Enable an approved transcription provider on the server." },
            { status: 503 },
          );
        }

        const configuredModel = envValue("POLLINATIONS_TRANSCRIPTION_MODEL", context ?? process.env) ?? "openai/whisper-large-v3";
        if (!/^[A-Za-z0-9._/-]{1,120}$/.test(configuredModel)) {
          return respond(
            { error: "TRANSCRIPTION_PROVIDER_CONFIGURATION_INVALID", message: "The configured transcription model name is invalid." },
            { status: 503 },
          );
        }

        const upstreamForm = new FormData();
        const extension = mimeType === "audio/mp4" ? "m4a"
          : mimeType === "audio/mpeg" ? "mp3"
          : mimeType === "audio/wav" ? "wav"
          : mimeType === "audio/ogg" ? "ogg"
          : "webm";
        // Copy into a concrete ArrayBuffer so BlobPart is safe across runtimes
        // whose Uint8Array.buffer is typed as ArrayBufferLike.
        const audioBuffer = Uint8Array.from(audioBytes).buffer;
        upstreamForm.set(
          "file",
          new Blob([audioBuffer], { type: mimeType }),
          "voice-turn." + extension,
        );
        upstreamForm.set("model", configuredModel);
        upstreamForm.set("response_format", "json");
        upstreamForm.set("temperature", "0");
        upstreamForm.set(
          "prompt",
          "Transcribe the spoken words verbatim in the language actually spoken. Preserve Hindi-English code-switching and the original writing system. Do not translate, summarize, or add commentary.",
        );
        if (language !== "auto" && /^[a-z]{2}$/.test(language)) {
          upstreamForm.set("language", language);
        }

        try {
          const providerSignal = AbortSignal.any([
            request.signal,
            AbortSignal.timeout(35_000),
          ]);
          const response = await fetch("https://gen.pollinations.ai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              authorization: "Bearer " + apiKey,
              accept: "application/json",
            },
            body: upstreamForm,
            signal: providerSignal,
          });

          if (request.signal.aborted) {
            return respond({ error: "TRANSCRIPTION_CANCELLED", message: "The voice session was stopped." }, { status: 499 });
          }

          if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* Provider error bodies are not needed. */ }
            if (response.status === 401 || response.status === 403) {
              return respond(
                { error: "TRANSCRIPTION_PROVIDER_AUTH_FAILED", message: "The transcription provider rejected its server key or model permissions. Check the server-side provider configuration." },
                { status: 503 },
              );
            }
            if (response.status === 402) {
              return respond(
                { error: "TRANSCRIPTION_PROVIDER_BUDGET_EXHAUSTED", message: "The transcription provider account has no available budget. No transcript was returned." },
                { status: 503 },
              );
            }
            if (response.status === 429) {
              return respond(
                { error: "TRANSCRIPTION_PROVIDER_RATE_LIMITED", message: "The transcription provider is rate limited. Please wait before speaking again." },
                { status: 429, headers: { "retry-after": response.headers.get("retry-after") ?? "30" } },
              );
            }
            if (response.status === 400 || response.status === 415 || response.status === 422) {
              return respond(
                { error: "TRANSCRIPTION_AUDIO_UNSUPPORTED", message: "The transcription provider could not process this audio format or model. Please record a new voice turn." },
                { status: 422 },
              );
            }
            if (response.status >= 500 || response.status === 408) {
              return respond(
                { error: "TRANSCRIPTION_PROVIDER_BUSY", message: "Voice transcription is temporarily unavailable. Please try again shortly." },
                { status: 503 },
              );
            }
            return respond(
              { error: "TRANSCRIPTION_PROVIDER_ERROR", message: "Voice transcription failed. Please try again." },
              { status: 502 },
            );
          }

          const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
          let transcript = "";
          if (contentType.includes("application/json")) {
            const payload: unknown = await response.json().catch(() => null);
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
              const value = (payload as Record<string, unknown>)["text"];
              if (typeof value === "string") transcript = value.trim();
            }
          } else if (contentType.startsWith("text/")) {
            transcript = (await response.text()).trim();
          } else {
            try { await response.body?.cancel(); } catch { /* Unexpected content is discarded. */ }
            return respond(
              { error: "TRANSCRIPTION_PROVIDER_BAD_RESPONSE", message: "The transcription provider returned an unsupported response." },
              { status: 502 },
            );
          }

          if (request.signal.aborted) {
            return respond({ error: "TRANSCRIPTION_CANCELLED", message: "The voice session was stopped." }, { status: 499 });
          }
          if (!transcript) {
            return respond(
              { error: "TRANSCRIPTION_NO_SPEECH", message: "No clear speech was detected. Please speak a little longer and try again." },
              { status: 422 },
            );
          }
          if (transcript.length > 20_000) {
            return respond(
              { error: "TRANSCRIPTION_RESPONSE_TOO_LARGE", message: "The transcription provider returned an unusually large response." },
              { status: 502 },
            );
          }
          return respond({ text: transcript });
        } catch (error) {
          if (request.signal.aborted) {
            return respond({ error: "TRANSCRIPTION_CANCELLED", message: "The voice session was stopped." }, { status: 499 });
          }
          const timedOut = error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError");
          return respond(
            {
              error: timedOut ? "TRANSCRIPTION_PROVIDER_TIMEOUT" : "TRANSCRIPTION_PROVIDER_UNREACHABLE",
              message: timedOut
                ? "Voice transcription took too long. Please try a shorter voice turn."
                : "Could not reach the configured transcription provider. Please try again shortly.",
            },
            { status: timedOut ? 504 : 503 },
          );
        }
      },
    },
  },
});