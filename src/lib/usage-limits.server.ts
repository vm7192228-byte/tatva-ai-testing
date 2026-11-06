import { getAuthenticatedSession } from "./auth-api.server";

type RuntimeEnv = Record<string, unknown>;
export type UsageFeature = "social_analysis" | "social_edit" | "image_generation" | "video_generation" | "file_analysis" | "super_chat";
export type UsageDecision = {
  allowed: boolean;
  planCode?: string;
  limit?: number;
  used?: number;
  remaining?: number;
  error?: string;
};

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object" ? (runtimeEnv as RuntimeEnv)[name] : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getSupabaseAdminKey(runtimeEnv: unknown): string | undefined {
  const dedicated = envValue("TATV_SUPABASE_SECRET_KEY", runtimeEnv);
  if (dedicated?.startsWith("sb_secret_")) return dedicated;
  return getSupabaseAdminKey(runtimeEnv);
}

function supabaseAdminHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: key,
    "content-type": "application/json",
  };
  // sb_secret_* is an opaque API key, not a JWT; legacy service_role is a JWT.
  if (!key.startsWith("sb_secret_")) headers.authorization = "Bearer " + key;
  return headers;
}

export async function consumeUsageQuota(runtimeEnv: unknown, userId: string, feature: UsageFeature): Promise<UsageDecision> {
  const url = (envValue("TATV_SUPABASE_URL", runtimeEnv) ?? envValue("SUPABASE_URL", runtimeEnv))?.replace(/\/$/, "");
  const key = getSupabaseAdminKey(runtimeEnv);
  if (!url || !key) throw new Error("USAGE_DATABASE_NOT_CONFIGURED");
  const response = await fetch(url + "/rest/v1/rpc/cf_consume_usage_quota", {
    method: "POST",
    headers: supabaseAdminHeaders(key),
    body: JSON.stringify({ p_user_id: userId, p_feature_code: feature }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("USAGE_QUOTA_CHECK_FAILED");
  const result = await response.json() as UsageDecision;
  if (!result || typeof result.allowed !== "boolean") throw new Error("USAGE_QUOTA_INVALID_RESPONSE");
  return result;
}

export async function consumeRequestQuota(request: Request, runtimeEnv: unknown, feature: UsageFeature) {
  const session = await getAuthenticatedSession(request, runtimeEnv, 2500);
  if (session.unavailable) {
    return {
      response: new Response(JSON.stringify({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      }),
      decision: null as UsageDecision | null,
    };
  }
  if (!session.user) {
    return {
      response: new Response(JSON.stringify({
        error: "AUTH_REQUIRED",
        message: "Sign in to CodeForge AI so your plan and monthly usage can be verified.",
      }), { status: 401, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }),
      decision: null as UsageDecision | null,
    };
  }
  const decision = await consumeUsageQuota(runtimeEnv, session.user.id, feature);
  if (!decision.allowed) {
    const featureName = feature === "social_analysis" ? "social analytics" :
      feature === "social_edit" ? "social edit actions" :
      feature === "image_generation" ? "image generation" : feature === "video_generation" ? "video generation" : feature === "file_analysis" ? "PDF and file analysis" : "Super Chat";
    const limitText = decision.limit === 0
      ? "This feature is not included in your current plan."
      : "You have used " + (decision.used ?? 0) + " of " + (decision.limit ?? 0) + " monthly uses.";
    return {
      response: new Response(JSON.stringify({
        error: "PLAN_LIMIT_REACHED",
        feature,
        planCode: decision.planCode ?? "free",
        limit: decision.limit ?? 0,
        used: decision.used ?? 0,
        remaining: 0,
        message: limitText + " Upgrade your CodeForge plan to use " + featureName + ".",
      }), { status: 402, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }),
      decision,
    };
  }
  return { response: null, decision };
}


export type UsageReservationDecision = UsageDecision & {
  reservationId?: string;
  status?: "reserved" | "committed" | "released";
};

export type UsageReservationAction = "commit" | "release";

/** Derive stable per-file reservation keys from one chat request key. */
export async function deriveUsageReservationKey(
  idempotencyKey: string,
  feature: UsageFeature,
  index: number,
): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey) ||
      !Number.isSafeInteger(index) || index < 0 || index > 100) {
    throw new Error("INVALID_USAGE_RESERVATION_KEY");
  }
  const input = new TextEncoder().encode("codeforge-usage:" + feature + ":" + idempotencyKey.toLowerCase() + ":" + index);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  // Mark the deterministic digest as an RFC 9562 version-8/variant UUID so Postgres
  // accepts it while retries of the same request and file index remain idempotent.
  digest.set([((digest.at(6) ?? 0) & 0x0f) | 0x80], 6);
  digest.set([((digest.at(8) ?? 0) & 0x3f) | 0x80], 8);
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
    hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

export async function reserveUsageQuota(
  runtimeEnv: unknown,
  userId: string,
  feature: UsageFeature,
  idempotencyKey: string,
): Promise<UsageReservationDecision> {
  const url = (envValue("TATV_SUPABASE_URL", runtimeEnv) ?? envValue("SUPABASE_URL", runtimeEnv))?.replace(/\/$/, "");
  const key = getSupabaseAdminKey(runtimeEnv);
  if (!url || !key) throw new Error("USAGE_DATABASE_NOT_CONFIGURED");
  const response = await fetch(url + "/rest/v1/rpc/cf_reserve_usage_quota", {
    method: "POST",
    headers: supabaseAdminHeaders(key),
    body: JSON.stringify({
      p_user_id: userId,
      p_feature_code: feature,
      p_idempotency_key: idempotencyKey,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("USAGE_QUOTA_RESERVATION_FAILED");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("USAGE_QUOTA_RESERVATION_INVALID_RESPONSE");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["allowed"] !== "boolean") throw new Error("USAGE_QUOTA_RESERVATION_INVALID_RESPONSE");
  if (record["allowed"] && typeof record["reservationId"] !== "string") {
    throw new Error("USAGE_QUOTA_RESERVATION_INVALID_RESPONSE");
  }
  const result: UsageReservationDecision = { allowed: record["allowed"] as boolean };
  if (typeof record["reservationId"] === "string") result.reservationId = record["reservationId"];
  if (record["status"] === "reserved" || record["status"] === "committed" || record["status"] === "released") {
    result.status = record["status"];
  }
  if (typeof record["planCode"] === "string") result.planCode = record["planCode"];
  if (typeof record["limit"] === "number") result.limit = record["limit"];
  if (typeof record["used"] === "number") result.used = record["used"];
  if (typeof record["remaining"] === "number") result.remaining = record["remaining"];
  if (typeof record["error"] === "string") result.error = record["error"];
  return result;
}

export async function finalizeUsageQuota(
  runtimeEnv: unknown,
  userId: string,
  reservationId: string,
  action: UsageReservationAction,
): Promise<{ ok: boolean; status?: "committed" | "released"; error?: string }> {
  const url = (envValue("TATV_SUPABASE_URL", runtimeEnv) ?? envValue("SUPABASE_URL", runtimeEnv))?.replace(/\/$/, "");
  const key = getSupabaseAdminKey(runtimeEnv);
  if (!url || !key) throw new Error("USAGE_DATABASE_NOT_CONFIGURED");
  const response = await fetch(url + "/rest/v1/rpc/cf_finalize_usage_quota", {
    method: "POST",
    headers: supabaseAdminHeaders(key),
    body: JSON.stringify({
      p_user_id: userId,
      p_reservation_id: reservationId,
      p_action: action,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("USAGE_QUOTA_FINALIZATION_FAILED");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("USAGE_QUOTA_FINALIZATION_INVALID_RESPONSE");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["ok"] !== "boolean") throw new Error("USAGE_QUOTA_FINALIZATION_INVALID_RESPONSE");
  const result: { ok: boolean; status?: "committed" | "released"; error?: string } = {
    ok: record["ok"] as boolean,
  };
  if (record["status"] === "committed" || record["status"] === "released") result.status = record["status"];
  if (typeof record["error"] === "string") result.error = record["error"];
  return result;
}


export type UsageReservationRef = {
  userId: string;
  reservationId: string;
};

/**
 * Finalize reservations before returning a non-streaming response. Unlike the
 * SSE wrapper below, this function awaits release so serverless runtimes cannot
 * terminate the request before quota cleanup is confirmed.
 */
export async function finalizeUsageReservationsResponse(
  response: Response,
  runtimeEnv: unknown,
  reservations: readonly UsageReservationRef[],
): Promise<Response> {
  const pending = reservations.filter(item =>
    typeof item.userId === "string" && item.userId.length > 0 &&
    typeof item.reservationId === "string" && item.reservationId.length > 0
  );
  if (!pending.length) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (response.body && contentType.includes("text/event-stream")) {
    return finalizeUsageReservationsStream(response, runtimeEnv, pending);
  }

  for (const item of pending) {
    let confirmed = false;
    for (let attempt = 0; attempt < 2 && !confirmed; attempt += 1) {
      try {
        const result = await finalizeUsageQuota(runtimeEnv, item.userId, item.reservationId, "release");
        confirmed = result.ok && result.status === "released";
      } catch {
        // Retry once in case the database committed before the request timed out.
      }
    }
    if (!confirmed) {
      console.error("[CodeForge AI] Non-streaming quota release was not confirmed; reservation expiry is the fallback.");
    }
  }
  return response;
}

/**
 * Finalize one or more reservations from a single CodeForge SSE stream.
 * A shared wrapper avoids double-reading/parsing when a chat request reserves
 * more than one meter (for example file analysis and paid chat).
 */
export function finalizeUsageReservationsStream(
  response: Response,
  runtimeEnv: unknown,
  reservations: readonly UsageReservationRef[],
): Response {
  const pending = reservations.filter(item =>
    typeof item.userId === "string" && item.userId.length > 0 &&
    typeof item.reservationId === "string" && item.reservationId.length > 0
  );
  if (!pending.length) return response;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    void Promise.all(pending.map(async item => {
      try {
        const result = await finalizeUsageQuota(runtimeEnv, item.userId, item.reservationId, "release");
        if (!result.ok || result.status !== "released") {
          console.error("[CodeForge AI] A quota reservation could not be released after a non-streaming response.");
        }
      } catch {
        console.error("[CodeForge AI] A quota reservation release failed after a non-streaming response.");
      }
    }));
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let sawError = false;
  let finalized = false;

  const finalize = async (action: UsageReservationAction) => {
    if (finalized) return;
    finalized = true;

    for (const item of pending) {
      let confirmed = false;
      // Retry once: the database RPC is idempotent for an already-finalized reservation.
      for (let attempt = 0; attempt < 2 && !confirmed; attempt += 1) {
        try {
          const result = await finalizeUsageQuota(runtimeEnv, item.userId, item.reservationId, action);
          confirmed = result.ok && result.status === (action === "commit" ? "committed" : "released");
        } catch {
          // Retry once in case the request timed out after the database committed.
        }
      }
      if (!confirmed) {
        console.error("[CodeForge AI] Quota reservation finalization was not confirmed; its expiry is the fallback.");
      }
    }
  };

  const inspectFrame = (frame: string) => {
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const payload: unknown = JSON.parse(data);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const event = payload as Record<string, unknown>;
      if (event["error"] !== undefined && event["error"] !== null && event["error"] !== "") sawError = true;
      if (event["done"] === true) sawDone = true;
    } catch {
      // Ignore non-JSON SSE frames; only the server-owned CodeForge envelope is counted.
    }
  };

  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          buffer += decoder.decode();
          if (buffer.trim()) inspectFrame(buffer);
          await finalize(sawDone && !sawError ? "commit" : "release");
          controller.close();
          return;
        }

        buffer += decoder.decode(result.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) inspectFrame(frame);
        if (sawDone) await finalize(sawError ? "release" : "commit");
        controller.enqueue(result.value);
      } catch (error) {
        try { await reader.cancel(error); } catch { /* Upstream may already be closed. */ }
        await finalize("release");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { await finalize("release"); }
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Backwards-compatible single-reservation stream finalizer for media routes. */
export function finalizeUsageReservationStream(
  response: Response,
  runtimeEnv: unknown,
  userId: string,
  reservationId: string | undefined,
): Response {
  return finalizeUsageReservationsStream(
    response,
    runtimeEnv,
    reservationId ? [{ userId, reservationId }] : [],
  );
}
