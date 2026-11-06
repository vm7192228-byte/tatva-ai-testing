type RuntimeEnv = Record<string, unknown>;

export type SharedRateLimitDecision = {
  allowed: boolean;
  attempts: number;
  retryAfterSeconds: number;
};

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object"
    ? (runtimeEnv as RuntimeEnv)[name]
    : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Uses the existing service-role-only shared rate-limit ledger. The legacy
 * table/RPC name mentions transcription, but its subject-hash key is generic;
 * scope-prefixing keeps chat, auth and transcription windows isolated.
 * Only a SHA-256 hash is persisted, never the raw user ID or IP address.
 */
export async function consumeSharedRateLimit(
  runtimeEnv: unknown,
  scope: string,
  subject: string,
  maxAttempts: number,
  windowSeconds: number,
): Promise<SharedRateLimitDecision> {
  if (!/^[a-z][a-z0-9_-]{1,31}$/i.test(scope) ||
      !subject.trim() || subject.length > 256 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100 ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 3600) {
    throw new Error("INVALID_SHARED_RATE_LIMIT_REQUEST");
  }
  const url = envValue("SUPABASE_URL", runtimeEnv)?.replace(/\/$/, "");
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY", runtimeEnv) ?? envValue("SUPABASE_SECRET_KEY", runtimeEnv);
  if (!url || !key) throw new Error("SHARED_RATE_LIMIT_NOT_CONFIGURED");

  const subjectHash = await sha256Hex("codeforge-rate-limit:" + scope.toLowerCase() + ":" + subject);
  const response = await fetch(url + "/rest/v1/rpc/cf_allow_transcription_attempt", {
    method: "POST",
    headers: {
      apikey: key,
      authorization: "Bearer " + key,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_subject_hash: subjectHash,
      p_max_attempts: maxAttempts,
      p_window_seconds: windowSeconds,
    }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error("SHARED_RATE_LIMIT_UNAVAILABLE");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("SHARED_RATE_LIMIT_INVALID_RESPONSE");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["allowed"] !== "boolean" ||
      !Number.isSafeInteger(record["attempts"]) ||
      !Number.isSafeInteger(record["retryAfterSeconds"])) {
    throw new Error("SHARED_RATE_LIMIT_INVALID_RESPONSE");
  }
  return {
    allowed: record["allowed"],
    attempts: record["attempts"] as number,
    retryAfterSeconds: Math.max(1, record["retryAfterSeconds"] as number),
  };
}
