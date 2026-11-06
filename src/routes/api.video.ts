import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedSession } from "../lib/auth-api.server";
import { createKieVideoTask, getKieVideoTask } from "../lib/kie-video-provider.server";
import { claimKieVideoStatusPoll, KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS } from "../lib/video-job-polling.server";

type Env = Record<string, unknown>;
type VideoJob = {
  id: string;
  user_id: string;
  provider: string;
  provider_task_id?: string | null;
  status: string;
  video_url?: string | null;
  plan_code?: string;
  duration_seconds?: number;
};

function envValue(name: string, context: unknown): string | undefined {
  const contextEnv = context && typeof context === "object" && "env" in context
    ? (context as { env?: Env }).env?.[name] : undefined;
  if (typeof contextEnv === "string" && contextEnv.trim()) return contextEnv.trim();
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }});
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function dbConfig(context: unknown) {
  const url = envValue("SUPABASE_URL", context);
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY", context) ?? envValue("SUPABASE_SECRET_KEY", context);
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

async function dbRequest(context: unknown, path: string, init: RequestInit = {}) {
  const cfg = dbConfig(context);
  if (!cfg) throw new Error("VIDEO_DATABASE_NOT_CONFIGURED");
  const headers = new Headers(init.headers);
  headers.set("apikey", cfg.key);
  headers.set("authorization", "Bearer " + cfg.key);
  headers.set("content-type", "application/json");
  return fetch(cfg.url + "/rest/v1/" + path, {
    ...init, headers, signal: init.signal ?? AbortSignal.timeout(12_000),
  });
}

async function patchJob(context: unknown, id: string, fields: Record<string, unknown>) {
  const response = await dbRequest(context, "cf_video_jobs?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error("VIDEO_JOB_UPDATE_FAILED");
}

/**
 * Poll results may race with a webhook callback. Restrict poll-driven updates
 * to active jobs so a stale "running" response cannot overwrite a terminal
 * succeeded/failed state committed by the callback.
 */
async function patchKieJobInStatuses(
  context: unknown,
  id: string,
  userId: string,
  statuses: "reserved" | "queued" | "reserved,queued" | "queued,in_progress" | "reserved,queued,in_progress",
  fields: Record<string, unknown>,
): Promise<boolean> {
  const statusFilter = statuses.includes(",")
    ? "status=in.(" + statuses + ")"
    : "status=eq." + statuses;
  const response = await dbRequest(
    context,
    "cf_video_jobs?id=eq." + encodeURIComponent(id) +
      "&user_id=eq." + encodeURIComponent(userId) +
      "&provider=eq.kie&" + statusFilter,
    {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) throw new Error("VIDEO_JOB_UPDATE_FAILED");
  const payload: unknown = await response.json();
  return Array.isArray(payload) && payload.some(item =>
    item && typeof item === "object" && (item as Record<string, unknown>)["id"] === id
  );
}

async function patchActiveKieJob(
  context: unknown,
  id: string,
  userId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  return patchKieJobInStatuses(context, id, userId, "queued,in_progress", fields);
}

async function fetchOwnedJob(context: unknown, id: string, userId: string): Promise<VideoJob | null> {
  const query = "cf_video_jobs?select=id,user_id,provider,provider_task_id,status,video_url,plan_code,duration_seconds"
    + "&id=eq." + encodeURIComponent(id)
    + "&user_id=eq." + encodeURIComponent(userId) + "&limit=1";
  const response = await dbRequest(context, query);
  if (!response.ok) throw new Error("VIDEO_JOB_READ_FAILED");
  const payload: unknown = await response.json();
  return Array.isArray(payload) && payload[0] && typeof payload[0] === "object"
    ? payload[0] as VideoJob : null;
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signKieJobToken(secret: string, jobId: string, expiresAt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("codeforge:kie-callback-job:v1:" + jobId + ":" + expiresAt),
  ));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function verifyKieJobToken(
  secret: string,
  jobId: string,
  expiresAt: string,
  token: string,
): Promise<boolean> {
  if (!/^[0-9]{10,12}$/.test(expiresAt) || !/^[A-Za-z0-9+/]{43}=$/.test(token)) return false;
  const expiresAtSeconds = Number(expiresAt);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(expiresAtSeconds) ||
      expiresAtSeconds <= nowSeconds ||
      expiresAtSeconds > nowSeconds + 24 * 60 * 60 + 300) {
    return false;
  }
  try {
    const signatureBytes = Uint8Array.from(atob(token), character => character.charCodeAt(0));
    if (signatureBytes.byteLength !== 32) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode("codeforge:kie-callback-job:v1:" + jobId + ":" + expiresAt),
    );
  } catch {
    return false;
  }
}

async function verifyKieCallback(
  secret: string,
  taskId: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  if (!/^[0-9]{10,12}$/.test(timestamp) || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) {
    return false;
  }

  try {
    const signatureBytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0));
    if (signatureBytes.byteLength !== 32) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(taskId + "." + timestamp),
    );
  } catch {
    return false;
  }
}

async function createKieCallbackUrl(
  request: Request,
  context: unknown,
  jobId: string,
): Promise<string | undefined> {
  const webhookHmacKey = envValue("KIE_WEBHOOK_HMAC_KEY", context);
  if (!webhookHmacKey) return undefined;
  try {
    const configuredBase = envValue("PUBLIC_APP_URL", context);
    const base = new URL(configuredBase || request.url);
    if (base.protocol !== "https:" || base.username || base.password) return undefined;
    const expiresAt = String(Math.floor(Date.now() / 1_000) + 24 * 60 * 60);
    const callback = new URL("/api/video", base.origin);
    callback.searchParams.set("callback", "1");
    callback.searchParams.set("jobId", jobId);
    callback.searchParams.set("expiresAt", expiresAt);
    callback.searchParams.set("jobToken", await signKieJobToken(webhookHmacKey, jobId, expiresAt));
    return callback.toString();
  } catch {
    return undefined;
  }
}

async function createKieJob(request: Request, context: unknown) {
  if (!sameOrigin(request)) return json({ message: "Cross-origin requests are not allowed." }, 403);
  const session = await getAuthenticatedSession(request, context);
  if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503);
  if (!session.user) return json({ message: "Sign in to generate a video." }, 401);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return json({ message: "Send a JSON request body." }, 415);
  }
  let raw: string;
  try { raw = await request.text(); } catch { return json({ message: "Could not read the request body." }, 400); }
  if (new TextEncoder().encode(raw).byteLength > 8_000) return json({ message: "Video request is too large." }, 413);
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return json({ message: "Invalid JSON body." }, 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ message: "Invalid video request." }, 400);

  const body = payload as Record<string, unknown>;
  const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
  if (!prompt || prompt.length > 1_800) return json({ message: "Prompt must contain 1–1,800 characters." }, 400);
  if (body["duration"] !== undefined && body["duration"] !== 5) {
    return json({ message: "The currently configured KIE model is enabled for 5-second jobs only." }, 400);
  }
  const aspectRatio = body["aspectRatio"] === "16:9" ? "16:9" : body["aspectRatio"] === "9:16" || body["aspectRatio"] === undefined ? "9:16" : null;
  if (!aspectRatio) return json({ message: "Choose 16:9 or 9:16 aspect ratio." }, 400);

  const idempotencyKey = request.headers.get("idempotency-key")?.trim()
    ?? (typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"].trim() : "");
  if (!validUuid(idempotencyKey)) return json({ message: "A valid UUID idempotency key is required in the Idempotency-Key header." }, 400);

  const apiKey = envValue("KIE_API_KEY", context);
  if (!apiKey) return json({
    code: "KIE_PROVIDER_NOT_CONFIGURED",
    message: "KIE video generation is not enabled. Configure KIE_API_KEY as a server-side Preview secret first.",
  }, 503);
  const model = envValue("KIE_VIDEO_MODEL", context) ?? "wan/2-7-text-to-video";
  const requestFingerprint = await fingerprint(JSON.stringify({ prompt, aspectRatio, duration: 5, model }));

  let reservation: Record<string, unknown>;
  try {
    const response = await dbRequest(context, "rpc/cf_reserve_kie_video_job", {
      method: "POST",
      body: JSON.stringify({
        p_user_id: session.user.id,
        p_duration_seconds: 5,
        p_idempotency_key: idempotencyKey,
        p_provider_model: model,
        p_request_fingerprint: requestFingerprint,
      }),
    });
    if (!response.ok) return json({ code: "VIDEO_USAGE_UNAVAILABLE", message: "CodeForge could not reserve your video credits. No provider request was sent." }, 503);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("VIDEO_RESERVATION_INVALID");
    reservation = result as Record<string, unknown>;
  } catch {
    return json({ code: "VIDEO_USAGE_UNAVAILABLE", message: "CodeForge could not verify your video allowance. No provider request was sent." }, 503);
  }

  if (reservation["ok"] !== true || typeof reservation["jobId"] !== "string") {
    if (reservation["error"] === "IDEMPOTENCY_KEY_REUSED") {
      return json({ code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key belongs to a different video request. Create a new request key to continue." }, 409);
    }
    if (reservation["error"] === "MONTHLY_LIMIT_REACHED") {
      return json({
        code: "PLAN_LIMIT_REACHED", feature: "video_generation",
        planCode: reservation["planCode"] ?? "free", limit: reservation["limit"] ?? 0,
        used: reservation["used"] ?? 0, remaining: reservation["remaining"] ?? 0,
        message: "Your monthly video credits have been used. Upgrade your CodeForge plan to generate more videos.",
      }, 402);
    }
    return json({ code: "VIDEO_PLAN_NOT_ELIGIBLE", message: "Video generation is not included in your current plan." }, 402);
  }

  const jobId = reservation["jobId"];
  const publicJobId = "kie_" + jobId;
  if (reservation["reused"] === true) {
    return json({
      jobId: publicJobId,
      status: reservation["status"] === "succeeded" ? "succeeded"
        : reservation["status"] === "failed" ? "failed"
        : reservation["providerTaskId"] ? "queued" : "submission_pending",
      ...(typeof reservation["videoUrl"] === "string" ? { videoUrl: reservation["videoUrl"] } : {}),
      provider: "KIE",
      reused: true,
      message: "This request was already submitted. CodeForge will not create a duplicate provider task.",
    }, 200);
  }

  try {
    const callbackUrl = await createKieCallbackUrl(request, context, jobId);
    const created = await createKieVideoTask(context, {
      model,
      modelInput: { prompt, ratio: aspectRatio, resolution: "720p", duration: 5, watermark: false },
      ...(callbackUrl ? { callBackUrl: callbackUrl } : {}),
    });
    try {
      const persisted = await patchKieJobInStatuses(
        context, jobId, session.user.id, "reserved",
        { provider_task_id: created.taskId, status: "queued" },
      );
      if (!persisted) {
        const current = await fetchOwnedJob(context, jobId, session.user.id);
        if (!current) throw new Error("VIDEO_JOB_READ_FAILED");
        return json({
          jobId: publicJobId,
          status: current.status,
          ...(typeof current.video_url === "string" ? { videoUrl: current.video_url } : {}),
          provider: "KIE",
          message: "The provider callback updated this job before the submission response was saved.",
        }, 202);
      }
    } catch {
      console.error("[CodeForge AI] KIE accepted a task but CodeForge could not persist its task id.");
      return json({
        jobId: publicJobId, status: "submission_pending", provider: "KIE",
        message: "The provider may have accepted this job. Its status is being reconciled; do not submit it again.",
      }, 202);
    }
    return json({ jobId: publicJobId, status: "queued", provider: "KIE" }, 202);
  } catch (error) {
    const code = error instanceof Error ? error.message : "KIE_UPSTREAM_ERROR";
    const uncertain = ["KIE_REQUEST_TIMEOUT", "KIE_UNREACHABLE", "KIE_INVALID_RESPONSE", "KIE_INVALID_TASK_ID", "KIE_UPSTREAM_ERROR"].includes(code);
    let reconciliationPending = false;
    if (!uncertain) {
      try {
        await patchJob(context, jobId, { status: "failed", provider_error_code: code.slice(0, 100) });
      } catch {
        reconciliationPending = true;
        console.error("[CodeForge AI] KIE rejected a task, but its quota reservation could not be finalized.");
      }
    }
    if (reconciliationPending) {
      return json({
        code: "KIE_RECONCILIATION_PENDING",
        jobId: publicJobId,
        status: "reconciliation_pending",
        message: "KIE rejected this request, but CodeForge could not save the failed-job status. Its video credit remains reserved for the current UTC month unless support reconciles it. Do not resubmit this request; share this job ID with support.",
      }, 503);
    }
    return json({
      code: uncertain ? "KIE_SUBMISSION_UNCONFIRMED" : "KIE_PROVIDER_ERROR",
      jobId: publicJobId,
      status: uncertain ? "submission_pending" : "failed",
      message: uncertain
        ? "KIE's response could not be confirmed. The reservation is retained to prevent duplicate paid tasks. Check this job before retrying."
        : "KIE could not accept this video request. The failed job will not count against your monthly CodeForge video allowance.",
    }, uncertain ? 202 : 502);
  }
}

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "timeout", "deleted"]);

async function handleKieCallback(request: Request, context: unknown): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const webhookHmacKey = envValue("KIE_WEBHOOK_HMAC_KEY", context);
  const expiresAt = url.searchParams.get("expiresAt") ?? "";
  const jobToken = url.searchParams.get("jobToken") ?? "";
  if (!validUuid(jobId) || !webhookHmacKey ||
      !await verifyKieJobToken(webhookHmacKey, jobId, expiresAt, jobToken)) {
    return json({ message: "KIE callback job token is invalid or expired." }, 401);
  }

  let raw: string;
  try { raw = await request.text(); } catch { return json({ message: "Could not read callback body." }, 400); }
  if (new TextEncoder().encode(raw).byteLength > 16_000) {
    return json({ message: "Callback body is too large." }, 413);
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return json({ message: "Invalid callback JSON." }, 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ message: "Invalid callback payload." }, 400);
  }
  const record = payload as Record<string, unknown>;
  const data = record["data"] && typeof record["data"] === "object" && !Array.isArray(record["data"])
    ? record["data"] as Record<string, unknown>
    : record;
  const taskId = typeof data["taskId"] === "string" ? data["taskId"] : "";
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(taskId)) {
    return json({ message: "Callback does not contain a valid task ID." }, 400);
  }

  const webhookTimestamp = request.headers.get("x-webhook-timestamp") ?? "";
  const webhookSignature = request.headers.get("x-webhook-signature") ?? "";
  if (!await verifyKieCallback(webhookHmacKey, taskId, webhookTimestamp, webhookSignature)) {
    return json({ message: "KIE callback signature is invalid or expired." }, 401);
  }

  try {
    // Verify the callback task against KIE's authenticated task lookup before
    // allowing it to update the durable job record.
    const task = await getKieVideoTask(context, taskId);
    if (task.taskId !== taskId) return json({ message: "KIE task verification failed." }, 403);

    const lookup = await dbRequest(
      context,
      "cf_video_jobs?select=id,user_id,provider,provider_task_id,status,video_url&id=eq." +
        encodeURIComponent(jobId) + "&provider=eq.kie&limit=1",
    );
    if (!lookup.ok) return json({ message: "Video job could not be verified." }, 503);
    const rows: unknown = await lookup.json();
    const job = Array.isArray(rows) && rows[0] && typeof rows[0] === "object"
      ? rows[0] as Record<string, unknown>
      : null;
    if (!job) return json({ message: "Video job not found." }, 404);
    const existingTaskId = typeof job["provider_task_id"] === "string" ? job["provider_task_id"] : "";
    if (existingTaskId && existingTaskId !== taskId) {
      return json({ message: "This job is already linked to a different KIE task." }, 409);
    }
    if (typeof job["user_id"] !== "string") return json({ message: "Video job owner could not be verified." }, 503);
    if (task.state === "succeeded" && !task.videoUrl) {
      // A terminal success without a retrievable URL is not yet a usable
      // result. Keep the job pollable rather than making it permanently stuck.
      const activeStatus = job["status"] === "in_progress" ? "in_progress" : "queued";
      const updated = await patchKieJobInStatuses(
        context, jobId, job["user_id"], "reserved,queued,in_progress",
        { provider_task_id: taskId, status: activeStatus },
      );
      if (updated) return json({
        ok: true, received: true, status: activeStatus,
        message: "KIE reports completion, but the video URL is not available yet. CodeForge will check again.",
      }, 202);
      const current = await fetchOwnedJob(context, jobId, job["user_id"]);
      if (!current) return json({ message: "Video job not found." }, 404);
      return json({
        ok: true, received: true, status: current.status,
        ...(typeof current.video_url === "string" ? { videoUrl: current.video_url } : {}),
        message: "KIE reports completion, but the video URL is not available yet.",
      }, current.status === "succeeded" && current.video_url ? 200 : 202);
    }
    const status = task.state === "succeeded" ? "succeeded"
      : task.state === "failed" ? "failed"
      : task.state === "running" ? "in_progress" : "queued";
    const allowedStatuses = status === "queued"
      ? "reserved,queued"
      : "reserved,queued,in_progress";
    const updated = await patchKieJobInStatuses(
      context,
      jobId,
      job["user_id"],
      allowedStatuses,
      {
        provider_task_id: taskId,
        status,
        ...(task.videoUrl ? { video_url: task.videoUrl } : {}),
        ...(task.errorCode ? { provider_error_code: task.errorCode } : {}),
      },
    );
    if (updated) return json({ ok: true, received: true, status });
    // A poll or another callback may have committed a terminal state after the
    // initial read. Return that authoritative state instead of overwriting it.
    const current = await fetchOwnedJob(context, jobId, job["user_id"]);
    if (!current) return json({ message: "Video job not found." }, 404);
    return json({
      ok: true,
      received: true,
      status: current.status,
      ...(typeof current.video_url === "string" ? { videoUrl: current.video_url } : {}),
    });
  } catch {
    return json({ message: "KIE callback could not be reconciled. The provider task will remain non-replayable." }, 503);
  }
}

export const Route = createFileRoute("/api/video")({
  server: { handlers: {
    POST: async ({ request, context }) =>
      new URL(request.url).searchParams.get("callback") === "1"
        ? handleKieCallback(request, context)
        : createKieJob(request, context),
    GET: async ({ request, context }) => {
      if (!sameOrigin(request)) return json({ message: "Cross-origin requests are not allowed." }, 403);
      const url = new URL(request.url);
      if (url.searchParams.get("status") === "wan") {
        return json({
          available: false, authenticated: false, paid: false,
          code: "LONG_FORM_VIDEO_PIPELINE_NOT_READY",
          message: "The legacy short-clip generator is retired. The full creator video pipeline is not enabled yet.",
        }, 503);
      }

      const session = await getAuthenticatedSession(request, context);
      if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503);
      if (!session.user) return json({ message: "Sign in to check your video jobs." }, 401);

      if (url.searchParams.get("history") === "1") {
        try {
          const query = "cf_video_jobs?select=id,status,video_url,created_at,provider_model,duration_seconds"
            + "&user_id=eq." + encodeURIComponent(session.user.id)
            + "&provider=eq.kie&order=created_at.desc&limit=12";
          const response = await dbRequest(context, query);
          if (!response.ok) return json({ message: "Video history is temporarily unavailable." }, 503);
          const payload: unknown = await response.json();
          const jobs = Array.isArray(payload) ? payload.flatMap(item => {
            if (!item || typeof item !== "object") return [];
            const row = item as Record<string, unknown>;
            if (typeof row["id"] !== "string" || !/^[0-9a-f-]{36}$/i.test(row["id"])) return [];
            const status = typeof row["status"] === "string" ? row["status"] : "queued";
            const videoUrl = typeof row["video_url"] === "string" ? row["video_url"] : null;
            let safeVideoUrl: string | null = null;
            if (videoUrl) {
              try {
                const parsed = new URL(videoUrl);
                if (parsed.protocol === "https:" && !parsed.username && !parsed.password) safeVideoUrl = parsed.href;
              } catch { /* omit invalid stored URLs */ }
            }
            return [{
              jobId: "kie_" + row["id"],
              status,
              ...(safeVideoUrl ? { videoUrl: safeVideoUrl } : {}),
              createdAt: typeof row["created_at"] === "string" ? row["created_at"] : null,
              model: typeof row["provider_model"] === "string" ? row["provider_model"] : null,
              durationSeconds: typeof row["duration_seconds"] === "number" ? row["duration_seconds"] : 5,
            }];
          }) : [];
          return json({ jobs });
        } catch {
          return json({ message: "Video history is temporarily unavailable." }, 503);
        }
      }

      const jobIdParam = url.searchParams.get("jobId") ?? "";
      const match = jobIdParam.match(/^(ws|kie)_([0-9a-f-]{36})$/i);
      if (!match) return json({ message: "Invalid video job id." }, 400);

      let job: VideoJob | null;
      try { job = await fetchOwnedJob(context, match[2]!, session.user.id); }
      catch { return json({ message: "Video job history is temporarily unavailable." }, 503); }
      if (!job) return json({ message: "Video job not found for this account." }, 404);
      if (job.status === "succeeded" && typeof job.video_url === "string") {
        return json({ status: "succeeded", videoUrl: job.video_url, provider: job.provider === "kie" ? "KIE" : "WaveSpeed" });
      }
      if (job.status === "failed") return json({
        status: "failed",
        message: "The video provider could not complete this job. A failed job does not count against your monthly allowance.",
      });
      if (job.provider === "kie") {
        if (!job.provider_task_id) return json({
          status: "submission_pending",
          message: "The provider submission has not yet been confirmed. Do not submit the prompt again with a new key.",
        }, 202);
        let pollClaimed = false;
        try {
          pollClaimed = await claimKieVideoStatusPoll(
            session.user.id,
            job.id,
            (path, init) => dbRequest(context, path, init),
          );
        } catch {
          return json({ message: "Could not safely reserve a KIE status check. Please retry later." }, 503);
        }
        if (!pollClaimed) {
          return json({
            status: job.status,
            provider: "KIE",
            retryAfterSeconds: KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS,
            message: "A recent status check is already in progress or this job was checked recently.",
          }, 200);
        }
        const currentJobResponse = async (): Promise<Response> => {
          const current = await fetchOwnedJob(context, job.id, job.user_id);
          if (!current) return json({ message: "Video job not found for this account." }, 404);
          if (current.status === "succeeded") {
            return json({
              status: "succeeded",
              ...(typeof current.video_url === "string" ? { videoUrl: current.video_url } : {}),
              provider: "KIE",
            });
          }
          if (current.status === "failed") {
            return json({
              status: "failed",
              message: "KIE could not complete this video. The failed job does not count against your monthly allowance.",
            });
          }
          return json({
            status: current.status,
            provider: "KIE",
            retryAfterSeconds: KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS,
          });
        };
        try {
          const task = await getKieVideoTask(context, job.provider_task_id);
          if (task.state === "succeeded") {
            if (task.videoUrl) {
              const updated = await patchActiveKieJob(context, job.id, job.user_id, {
                status: "succeeded", video_url: task.videoUrl, provider_error_code: null,
              });
              return updated
                ? json({ status: "succeeded", videoUrl: task.videoUrl, provider: "KIE" })
                : await currentJobResponse();
            }
            return json({
              status: job.status,
              provider: "KIE",
              retryAfterSeconds: KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS,
              message: "KIE reports completion, but the video URL is not available yet. CodeForge will check again.",
            }, 202);
          }
          if (task.state === "failed") {
            const updated = await patchActiveKieJob(context, job.id, job.user_id, {
              status: "failed", provider_error_code: task.errorCode ?? "KIE_TASK_FAILED",
            });
            return updated
              ? json({ status: "failed", message: "KIE could not complete this video. The failed job does not count against your monthly allowance." })
              : await currentJobResponse();
          }
          const status = task.state === "running" ? "in_progress" : "queued";
          if (job.status !== status) {
            const updated = status === "queued"
              ? await patchKieJobInStatuses(context, job.id, job.user_id, "reserved,queued", { status })
              : await patchActiveKieJob(context, job.id, job.user_id, { status });
            if (!updated) return await currentJobResponse();
          }
          return json({ status, provider: "KIE", retryAfterSeconds: KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS });
        } catch {
          return json({ message: "Could not check KIE task status. Please retry later." }, 502);
        }
      }

      const taskId = typeof job.provider_task_id === "string" ? job.provider_task_id : "";
      if (!taskId) return json({ status: "queued", message: "The provider task ID is not available yet. Do not submit the prompt again." });
      const providerKey = envValue("WAVESPEED_API_KEY", context);
      if (!providerKey) return json({ message: "WaveSpeed is not configured." }, 503);
      try {
        const resultResponse = await fetch("https://api.wavespeed.ai/api/v3/predictions/" + encodeURIComponent(taskId) + "/result", {
          headers: { authorization: "Bearer " + providerKey }, signal: AbortSignal.timeout(12_000),
        });
        let resultPayload: unknown = {};
        try { resultPayload = await resultResponse.json(); } catch { /* normalized below */ }
        const payload = resultPayload && typeof resultPayload === "object" ? resultPayload as Record<string, unknown> : {};
        const result = payload["data"] && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : payload;
        if (!resultResponse.ok) return json({ message: "Could not check WaveSpeed task status. Please retry." }, 502);
        const state = typeof result["status"] === "string" ? result["status"].toLowerCase() : "queued";
        if (TERMINAL_FAILURES.has(state)) {
          await patchJob(context, job.id, { status: "failed" });
          return json({ status: "failed", message: "WaveSpeed could not complete this video. A failed job does not count against your monthly allowance." });
        }
        if (state === "completed") {
          const outputs = result["outputs"];
          const videoUrl = Array.isArray(outputs) ? outputs.map(item =>
            typeof item === "string" ? item
              : item && typeof item === "object" && typeof (item as Record<string, unknown>)["url"] === "string"
                ? (item as Record<string, unknown>)["url"] as string : ""
          ).find(value => {
            try {
              const parsed = new URL(value);
              return parsed.protocol === "https:" && !parsed.username && !parsed.password;
            } catch {
              return false;
            }
          }) ?? "" : "";
          if (!videoUrl) return json({ message: "WaveSpeed completed the task but returned no playable video URL." }, 502);
          await patchJob(context, job.id, { status: "succeeded", video_url: videoUrl });
          return json({ status: "succeeded", videoUrl, provider: "WaveSpeed" });
        }
        const status = ["processing", "in_progress", "running"].includes(state) ? "in_progress" : "queued";
        if (job.status !== status) await patchJob(context, job.id, { status });
        return json({ status, provider: "WaveSpeed" });
      } catch {
        return json({ message: "Could not reach WaveSpeed job status. Please retry." }, 502);
      }
    },
  }},
});
