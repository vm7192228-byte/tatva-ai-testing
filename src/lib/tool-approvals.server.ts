import { getAuthenticatedSession } from "./auth-api.server";
import { handleSocialApiRequest } from "./social-api.server";

type RuntimeEnv = Record<string, unknown>;
type ApprovalStatus = "pending" | "executing" | "executed" | "rejected" | "failed" | "expired" | "uncertain";
type ApprovalActionName =
  | "youtube_update_video"
  | "youtube_delete_video"
  | "facebook_publish_post"
  | "instagram_publish_post";

type ApprovalRecord = {
  id: string;
  user_id: string;
  tool_name: ApprovalActionName;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: ApprovalStatus;
  result?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  decided_at?: string | null;
  finished_at?: string | null;
};

type ApprovalActionConfig = {
  label: string;
  description: string;
  endpoint: string;
  destructive: boolean;
};

const ACTIONS: Record<ApprovalActionName, ApprovalActionConfig> = {
  youtube_update_video: {
    label: "Update YouTube video",
    description: "Change metadata on a video owned by your connected YouTube channel.",
    endpoint: "/api/social/youtube/video-update",
    destructive: false,
  },
  youtube_delete_video: {
    label: "Delete YouTube video",
    description: "Permanently delete a video owned by your connected YouTube channel.",
    endpoint: "/api/social/youtube/video-delete",
    destructive: true,
  },
  facebook_publish_post: {
    label: "Publish Facebook post",
    description: "Publish a post to the Facebook Page you selected.",
    endpoint: "/api/social/facebook/post",
    destructive: false,
  },
  instagram_publish_post: {
    label: "Publish Instagram post",
    description: "Publish a post to the Instagram account you selected.",
    endpoint: "/api/social/instagram/post",
    destructive: false,
  },
};

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const bindings = runtimeEnv && typeof runtimeEnv === "object" ? runtimeEnv as RuntimeEnv : {};
  const configured = bindings[name];
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  const fallback = processLike?.env?.[name];
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : undefined;
}

function serviceConfig(runtimeEnv: unknown): { baseUrl: string; key: string } | null {
  const baseUrl = envValue("SUPABASE_URL", runtimeEnv)?.replace(/\/$/, "");
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY", runtimeEnv) ?? envValue("SUPABASE_SECRET_KEY", runtimeEnv);
  return baseUrl && key ? { baseUrl, key } : null;
}

function serviceHeaders(key: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    apikey: key,
    authorization: "Bearer " + key,
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isActionName(value: string): value is ApprovalActionName {
  return Object.prototype.hasOwnProperty.call(ACTIONS, value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
}
function approvalPreview(record: Pick<ApprovalRecord, "tool_name" | "payload">) {
  const config = ACTIONS[record.tool_name];
  const payload = record.payload;
  const preview: Record<string, unknown> = {};
  for (const key of ["videoId", "pageId", "title", "description", "tags", "privacyStatus", "message", "imageUrl", "videoUrl"]) {
    if (payload[key] !== undefined) preview[key] = payload[key];
  }
  return {
    toolName: record.tool_name,
    label: config.label,
    description: config.description,
    destructive: config.destructive,
    preview,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function restRequest(
  runtimeEnv: unknown,
  tablePath: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const config = serviceConfig(runtimeEnv);
  if (!config) throw new Error("TOOL_APPROVAL_DATABASE_NOT_CONFIGURED");
  const headers = new Headers(init.headers);
  headers.set("apikey", config.key);
  headers.set("authorization", "Bearer " + config.key);
  headers.set("content-type", "application/json");
  return fetch(config.baseUrl + "/rest/v1/" + tablePath, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

async function readOwnedApproval(
  runtimeEnv: unknown,
  userId: string,
  approvalId: string,
): Promise<ApprovalRecord | null> {
  const query = "cf_tool_action_approvals?id=eq." + encodeURIComponent(approvalId) +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&select=id,user_id,tool_name,payload,idempotency_key,status,result,created_at,updated_at,expires_at,decided_at,finished_at&limit=1";
  const response = await restRequest(runtimeEnv, query);
  if (!response.ok) throw new Error("TOOL_APPROVAL_READ_FAILED");
  const rows = await response.json() as ApprovalRecord[];
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Called only by the server-owned tool registry after strict schema validation. */
export async function createPendingToolApproval(
  runtimeEnv: unknown,
  userId: string,
  idempotencyKey: string,
  toolName: string,
  payload: Record<string, unknown>,
  origin: string,
): Promise<{
  id: string;
  toolName: ApprovalActionName;
  label: string;
  description: string;
  destructive: boolean;
  preview: Record<string, unknown>;
  approvalUrl: string;
  expiresAt: string;
}> {
  if (!isActionName(toolName) || !isUuid(userId) || !idempotencyKey || idempotencyKey.length > 220) {
    throw new Error("INVALID_TOOL_APPROVAL");
  }
  const parsedOrigin = new URL(origin);
  const isLocalDevelopmentOrigin = parsedOrigin.protocol === "http:" && parsedOrigin.hostname === "localhost";
  if (parsedOrigin.protocol !== "https:" && !isLocalDevelopmentOrigin) {
    throw new Error("INVALID_TOOL_APPROVAL_ORIGIN");
  }
  const now = new Date();
  const recordId = crypto.randomUUID();
  const row = {
    id: recordId,
    user_id: userId,
    tool_name: toolName,
    payload,
    idempotency_key: idempotencyKey,
    status: "pending",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
  const insertPath = "cf_tool_action_approvals?on_conflict=user_id,idempotency_key" +
    "&select=id,user_id,tool_name,payload,idempotency_key,status,result,created_at,updated_at,expires_at,decided_at,finished_at";
  const inserted = await restRequest(runtimeEnv, insertPath, {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  if (!inserted.ok) throw new Error("TOOL_APPROVAL_CREATE_FAILED");
  let record = (await inserted.json() as ApprovalRecord[])[0];
  if (!record) {
    const query = "cf_tool_action_approvals?user_id=eq." + encodeURIComponent(userId) +
      "&idempotency_key=eq." + encodeURIComponent(idempotencyKey) +
      "&select=id,user_id,tool_name,payload,idempotency_key,status,result,created_at,updated_at,expires_at,decided_at,finished_at&limit=1";
    const duplicate = await restRequest(runtimeEnv, query);
    if (!duplicate.ok) throw new Error("TOOL_APPROVAL_IDEMPOTENCY_LOOKUP_FAILED");
    record = (await duplicate.json() as ApprovalRecord[])[0];
  }
  if (!record) throw new Error("TOOL_APPROVAL_CREATE_FAILED");
  if (record.tool_name !== toolName || stableJson(record.payload) !== stableJson(payload)) {
    throw new Error("TOOL_APPROVAL_IDEMPOTENCY_CONFLICT");
  }
  if (record.status !== "pending" || Date.parse(record.expires_at) <= Date.now()) {
    throw new Error("TOOL_APPROVAL_ALREADY_RESOLVED");
  }
  const config = ACTIONS[record.tool_name];
  return {
    id: record.id,
    toolName: record.tool_name,
    label: config.label,
    description: config.description,
    destructive: config.destructive,
    preview: approvalPreview(record).preview,
    approvalUrl: new URL("/tool-approvals/" + record.id, parsedOrigin).toString(),
    expiresAt: record.expires_at,
  };
}

async function updateOwnedApproval(
  runtimeEnv: unknown,
  userId: string,
  approvalId: string,
  fromStatus: ApprovalStatus,
  patch: Record<string, unknown>,
  extraFilter = "",
): Promise<ApprovalRecord | null> {
  const query = "cf_tool_action_approvals?id=eq." + encodeURIComponent(approvalId) +
    "&user_id=eq." + encodeURIComponent(userId) +
    "&status=eq." + encodeURIComponent(fromStatus) + extraFilter +
    "&select=id,user_id,tool_name,payload,idempotency_key,status,result,created_at,updated_at,expires_at,decided_at,finished_at";
  const response = await restRequest(runtimeEnv, query, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error("TOOL_APPROVAL_UPDATE_FAILED");
  const rows = await response.json() as ApprovalRecord[];
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function cookiesFrom(response: Response): string[] {
  const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values?.length) return values;
  const value = response.headers.get("set-cookie");
  return value ? [value] : [];
}

function cookiesForInternalRequest(request: Request, refreshedCookies: string[]): string {
  const values = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) values.set(name, value);
  }
  for (const cookie of refreshedCookies) {
    const first = cookie.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!name) continue;
    if (!value || cookie.toLowerCase().includes("max-age=0")) values.delete(name);
    else values.set(name, value);
  }
  return [...values.entries()].map(([name, value]) => name + "=" + value).join("; ");
}

function sameOriginStrict(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

const STALE_APPROVAL_EXECUTION_MS = 5 * 60_000;
const STALE_APPROVAL_RESULT = {
  message: "The action was started, but Tatv could not confirm its final result. Check the connected platform before requesting it again.",
};

async function reconcileStaleApprovalExecution(
  runtimeEnv: unknown,
  userId: string,
  record: ApprovalRecord,
): Promise<ApprovalRecord> {
  const updatedAt = Date.parse(record.updated_at);
  if (record.status !== "executing" || !Number.isFinite(updatedAt) ||
      Date.now() - updatedAt < STALE_APPROVAL_EXECUTION_MS) {
    return record;
  }

  try {
    const recovered = await updateOwnedApproval(runtimeEnv, userId, record.id, "executing", {
      status: "uncertain",
      result: STALE_APPROVAL_RESULT,
      finished_at: new Date().toISOString(),
    });
    if (recovered) return recovered;

    // Another request may have completed the transition between our read and
    // conditional update. Re-read rather than overwrite its terminal state.
    return await readOwnedApproval(runtimeEnv, userId, record.id) ?? record;
  } catch {
    // The read is still enough to tell the owner not to retry automatically.
    // The next page load can persist this same conditional recovery transition.
    return { ...record, status: "uncertain", result: STALE_APPROVAL_RESULT };
  }
}

function publicStatus(record: ApprovalRecord): string {
  return record.status === "pending" && Date.parse(record.expires_at) <= Date.now()
    ? "expired"
    : record.status;
}

/** Owner-authenticated approval API. Every write is a conditional one-row transition. */
export async function handleToolApprovalsApiRequest(
  request: Request,
  runtimeEnv: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/tool-approvals/")) return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED", message: "Use GET or POST for approval actions." }, 405);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const approvalId = parts[2];
  if (!isUuid(approvalId)) return json({ error: "INVALID_APPROVAL_ID", message: "This approval link is invalid." }, 400);

  const session = await getAuthenticatedSession(request, runtimeEnv, 5_000);
  if (!session.configured) return json({ error: "AUTH_NOT_CONFIGURED", message: "Account authentication is not configured." }, 503);
  if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503, session.cookies);
  if (!session.user) return json({ error: "AUTH_REQUIRED", message: "Sign in with the account that created this approval." }, 401, session.cookies);

  if (request.method === "GET" && parts.length === 3) {
    let record: ApprovalRecord | null;
    try { record = await readOwnedApproval(runtimeEnv, session.user.id, approvalId); }
    catch {
      return json({ error: "APPROVAL_UNAVAILABLE", message: "This approval could not be loaded. Please try again." }, 503, session.cookies);
    }
    if (!record) return json({ error: "APPROVAL_NOT_FOUND", message: "This approval does not exist for the signed-in account." }, 404, session.cookies);
    record = await reconcileStaleApprovalExecution(runtimeEnv, session.user.id, record);
    const preview = approvalPreview(record);
    return json({
      ok: true,
      approval: {
        id: record.id,
        ...preview,
        status: publicStatus(record),
        createdAt: record.created_at,
        expiresAt: record.expires_at,
        result: record.result ?? null,
      },
    }, 200, session.cookies);
  }

  if (request.method !== "POST" || parts.length !== 4 || (parts[3] !== "approve" && parts[3] !== "reject")) {
    return json({ error: "NOT_FOUND", message: "Approval endpoint not found." }, 404, session.cookies);
  }
  if (!sameOriginStrict(request)) {
    return json({ error: "ORIGIN_NOT_ALLOWED", message: "Approval decisions must come from this Tatv page." }, 403, session.cookies);
  }

  let decisionPayload: Record<string, unknown> = {};
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2_000) return json({ error: "INVALID_BODY", message: "The approval request is too large." }, 400, session.cookies);
    if (raw.trim()) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      decisionPayload = parsed as Record<string, unknown>;
    }
  } catch {
    return json({ error: "INVALID_BODY", message: "The approval request must be valid JSON." }, 400, session.cookies);
  }

  let record: ApprovalRecord | null;
  try { record = await readOwnedApproval(runtimeEnv, session.user.id, approvalId); }
  catch {
    return json({ error: "APPROVAL_UNAVAILABLE", message: "This approval could not be verified. Please try again." }, 503, session.cookies);
  }
  if (!record) return json({ error: "APPROVAL_NOT_FOUND", message: "This approval does not exist for the signed-in account." }, 404, session.cookies);
  if (record.status !== "pending") {
    return json({ error: "APPROVAL_ALREADY_RESOLVED", status: publicStatus(record), message: "This approval has already been decided and cannot be used again." }, 409, session.cookies);
  }
  if (Date.parse(record.expires_at) <= Date.now()) {
    try {
      await updateOwnedApproval(runtimeEnv, session.user.id, approvalId, "pending", {
        status: "expired",
        decided_at: new Date().toISOString(),
      });
    } catch { /* The expiry check still denies execution. */ }
    return json({ error: "APPROVAL_EXPIRED", status: "expired", message: "This approval has expired. Ask Tatv to create a new one." }, 410, session.cookies);
  }

  const config = ACTIONS[record.tool_name];
  if (parts[3] === "reject") {
    let rejected: ApprovalRecord | null;
    try {
      rejected = await updateOwnedApproval(runtimeEnv, session.user.id, approvalId, "pending", {
        status: "rejected",
        decided_at: new Date().toISOString(),
      }, "&expires_at=gt." + encodeURIComponent(new Date().toISOString()));
    } catch {
      return json({ error: "APPROVAL_UNAVAILABLE", message: "The approval decision could not be saved. Please try again." }, 503, session.cookies);
    }
    if (!rejected) return json({ error: "APPROVAL_ALREADY_RESOLVED", message: "This approval has already been decided." }, 409, session.cookies);
    return json({ ok: true, status: "rejected", message: "The proposed action was rejected. Nothing was sent to the social platform." }, 200, session.cookies);
  }

  if (config.destructive && decisionPayload["confirmDelete"] !== true) {
    return json({ error: "EXPLICIT_CONFIRMATION_REQUIRED", message: "Confirm this deletion in the approval page before proceeding." }, 400, session.cookies);
  }

  let claimed: ApprovalRecord | null;
  try {
    claimed = await updateOwnedApproval(runtimeEnv, session.user.id, approvalId, "pending", {
      status: "executing",
      decided_at: new Date().toISOString(),
    }, "&expires_at=gt." + encodeURIComponent(new Date().toISOString()));
  } catch {
    return json({ error: "APPROVAL_UNAVAILABLE", message: "The action could not be claimed safely. Nothing was sent to the platform." }, 503, session.cookies);
  }
  if (!claimed) return json({ error: "APPROVAL_ALREADY_RESOLVED", message: "This approval has expired or has already been used." }, 409, session.cookies);

  // The existing social API performs the final OAuth, ownership and quota checks.
  // A claimed action is never automatically replayed after an ambiguous failure.
  try {
    const internalRequest = new Request(new URL(config.endpoint, url.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: url.origin,
        cookie: cookiesForInternalRequest(request, session.cookies),
      },
      body: JSON.stringify(claimed.payload),
    });
    const socialResponse = await handleSocialApiRequest(internalRequest, runtimeEnv);
    if (!socialResponse) throw new Error("SOCIAL_ACTION_ROUTE_MISSING");
    const socialPayload = await readJson(socialResponse);
    const hasExplicitFailure = socialPayload["ok"] === false || Boolean(socialPayload["error"]);
    // A 2xx response is not proof that the external action completed. Require
    // the social route's explicit { ok: true } confirmation before marking it
    // executed; an empty or malformed 2xx response has an unknown outcome.
    const succeeded = socialResponse.ok && socialPayload["ok"] === true && !hasExplicitFailure;
    const uncertain = !succeeded && (
      socialResponse.status === 408 || socialResponse.status === 429 ||
      socialResponse.status === 500 || socialResponse.status === 502 ||
      socialResponse.status === 503 || socialResponse.status === 504 ||
      (socialResponse.ok && !hasExplicitFailure)
    );
    const terminalStatus: ApprovalStatus = succeeded ? "executed" : uncertain ? "uncertain" : "failed";
    const safeResult = succeeded
      ? { message: "The connected platform confirmed the action.", platformStatus: socialResponse.status }
      : uncertain
        ? { message: "The platform response is uncertain. Check the connected account before trying again.", platformStatus: socialResponse.status }
        : { message: "The connected platform rejected the action.", platformStatus: socialResponse.status };
    try {
      await updateOwnedApproval(runtimeEnv, session.user.id, approvalId, "executing", {
        status: terminalStatus,
        result: safeResult,
        finished_at: new Date().toISOString(),
      });
    } catch {
      console.error("[Tatv AI] Tool action finished but its approval status could not be persisted.");
    }
    return json({
      ok: succeeded,
      status: terminalStatus,
      message: succeeded
        ? "The connected platform confirmed the action."
        : uncertain
          ? "Tatv could not verify the platform response. Check your connected account before requesting the action again."
          : "The platform rejected the action or its permissions. Review the connected account before creating a new request.",
    }, succeeded ? 200 : 502, [...session.cookies, ...cookiesFrom(socialResponse)]);
  } catch {
    try {
      await updateOwnedApproval(runtimeEnv, session.user.id, approvalId, "executing", {
        status: "uncertain",
        result: { message: "The platform response could not be verified. Do not repeat this action automatically." },
        finished_at: new Date().toISOString(),
      });
    } catch {
      console.error("[Tatv AI] An approved social action has an unverified outcome; the approval remains non-replayable.");
    }
    return json({
      error: "ACTION_OUTCOME_UNCERTAIN",
      status: "uncertain",
      message: "Tatv could not verify the platform response. Check your connected account before requesting the action again.",
    }, 502, session.cookies);
  }
}
