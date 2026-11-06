import { getAuthenticatedSession } from "./auth-api.server";
import { consumeSharedRateLimit } from "./shared-rate-limit.server";

type RuntimeEnv = Record<string, unknown>;

const UPLOAD_BUCKET = "tatv-private-uploads";
export const MAX_CHAT_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOADS_PER_MESSAGE = 4;
const ALLOWED_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/webm",
  "audio/wav",
  "audio/mp4",
  "audio/ogg",
]);
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const values = runtimeEnv && typeof runtimeEnv === "object"
    ? runtimeEnv as RuntimeEnv
    : {};
  const value = values[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  const nested = values["env"] && typeof values["env"] === "object"
    ? (values["env"] as RuntimeEnv)[name]
    : undefined;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  const processLike = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const processValue = processLike?.env?.[name];
  return typeof processValue === "string" && processValue.trim() ? processValue.trim() : undefined;
}

function storageConfig(runtimeEnv: unknown) {
  const rawUrl = envValue("SUPABASE_URL", runtimeEnv);
  const serviceKey = envValue("SUPABASE_SERVICE_ROLE_KEY", runtimeEnv)
    ?? envValue("SUPABASE_SECRET_KEY", runtimeEnv);
  if (!rawUrl || !serviceKey) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return null;
    return { baseUrl: parsed.origin, serviceKey };
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200, cookies: string[] = []) {
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


async function readRequestBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8_000) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > 8_000) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function uploadPathFor(userId: string, mimeType: string): string {
  return userId + "/chat/" + crypto.randomUUID() + "." + EXTENSIONS[mimeType];
}

export function isOwnedChatUploadPath(userId: string, path: string): boolean {
  if (!UUID_PATTERN.test(userId) || typeof path !== "string") return false;
  const prefix = userId + "/chat/";
  if (!path.startsWith(prefix)) return false;
  const filename = path.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](?:jpg|png|webp|gif|pdf|mp4|webm|mp3|wav|m4a|ogg)$/i.test(filename);
}

async function readBoundedStorageBody(response: Response, maxBytes: number): Promise<Uint8Array | "too-large" | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* Stop an oversized object. */ }
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type OwnedChatUploadReadResult =
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; status: number; error: string; message: string };

/** Reads one private chat upload only after checking its user-owned path, declared size and MIME type. */
export async function readOwnedChatUpload(
  runtimeEnv: unknown,
  userId: string,
  path: string,
  expectedMimeType: string,
  expectedSize: number,
  maxBytes = MAX_CHAT_UPLOAD_BYTES,
  signal?: AbortSignal,
): Promise<OwnedChatUploadReadResult> {
  if (!isOwnedChatUploadPath(userId, path)) {
    return { ok: false, status: 403, error: "UPLOAD_OWNER_MISMATCH", message: "This file does not belong to your signed-in account." };
  }
  const mimeType = expectedMimeType.trim().toLowerCase();
  if (!ALLOWED_UPLOAD_TYPES.has(mimeType) ||
      !Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CHAT_UPLOAD_BYTES ||
      expectedSize > maxBytes) {
    return { ok: false, status: 413, error: "UPLOAD_METADATA_INVALID", message: "The uploaded file type or size is not allowed." };
  }
  const config = storageConfig(runtimeEnv);
  if (!config) {
    return { ok: false, status: 503, error: "UPLOAD_STORAGE_NOT_CONFIGURED", message: "Private file storage is not configured on the server." };
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await storageRequest(config, "/object/authenticated/" + UPLOAD_BUCKET + "/" + encodedPath, {
      method: "GET",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    });
  } catch {
    if (signal?.aborted) {
      return { ok: false, status: 499, error: "UPLOAD_READ_CANCELLED", message: "The file request was cancelled." };
    }
    return { ok: false, status: 502, error: "UPLOAD_READ_FAILED", message: "Private storage could not read the uploaded file." };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Stop an unavailable object response. */ }
    return {
      ok: false,
      status: response.status === 404 ? 422 : 502,
      error: "UPLOAD_OBJECT_UNAVAILABLE",
      message: "The uploaded file is missing or no longer available. Attach it again.",
    };
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* Stop an oversized object response. */ }
    return { ok: false, status: 413, error: "UPLOAD_SIZE_INVALID", message: "The uploaded file exceeds the allowed size." };
  }
  const bytes = await readBoundedStorageBody(response, maxBytes);
  if (bytes === "too-large") {
    return { ok: false, status: 413, error: "UPLOAD_SIZE_INVALID", message: "The uploaded file exceeds the allowed size." };
  }
  if (!bytes) {
    return { ok: false, status: 502, error: "UPLOAD_READ_FAILED", message: "The uploaded file could not be read completely." };
  }
  if (bytes.byteLength === 0 || bytes.byteLength !== expectedSize) {
    return { ok: false, status: 422, error: "UPLOAD_SIZE_MISMATCH", message: "The uploaded file size did not match its metadata. Attach it again." };
  }
  const actualType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (actualType && actualType !== mimeType && actualType !== "application/octet-stream") {
    return { ok: false, status: 422, error: "UPLOAD_TYPE_MISMATCH", message: "The uploaded file type did not match its metadata." };
  }
  return { ok: true, bytes, mimeType };
}

async function storageRequest(
  config: { baseUrl: string; serviceKey: string },
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", config.serviceKey);
  headers.set("authorization", "Bearer " + config.serviceKey);
  headers.set("accept", "application/json");
  return fetch(config.baseUrl + "/storage/v1" + path, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

async function createSignedUpload(
  runtimeEnv: unknown,
  userId: string,
  body: Record<string, unknown>,
  cookies: string[],
): Promise<Response> {
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const mimeType = typeof body["mimeType"] === "string" ? body["mimeType"].trim().toLowerCase() : "";
  const size = typeof body["size"] === "number" ? body["size"] : Number(body["size"]);
  if (!name || Array.from(name).length > 240 ||
      !ALLOWED_UPLOAD_TYPES.has(mimeType) ||
      !Number.isSafeInteger(size) || size <= 0 || size > MAX_CHAT_UPLOAD_BYTES) {
    return json({
      error: "INVALID_UPLOAD",
      message: "Choose a supported image, PDF, audio or video file up to 10 MB.",
    }, 400, cookies);
  }

  const config = storageConfig(runtimeEnv);
  if (!config) {
    return json({
      error: "UPLOAD_STORAGE_NOT_CONFIGURED",
      message: "Private file storage is not configured on the server yet.",
    }, 503, cookies);
  }

  const path = uploadPathFor(userId, mimeType);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await storageRequest(config, "/object/upload/sign/" + UPLOAD_BUCKET + "/" + encodedPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    return json({ error: "UPLOAD_SIGN_FAILED", message: "Private storage could not prepare this upload. Please try again." }, 502, cookies);
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* Return a generic error below; do not expose upstream internals. */ }
  if (!response.ok || typeof payload["url"] !== "string") {
    console.error("[Dhwani uploads] Supabase could not create a signed upload URL:", response.status);
    return json({
      error: "UPLOAD_SIGN_FAILED",
      message: response.status === 404
        ? "Private upload storage has not been created yet. Apply the Workbench storage migration before testing uploads."
        : "Private storage could not prepare this upload. Please try again.",
    }, response.status === 404 ? 503 : 502, cookies);
  }

  let signedUrl: URL;
  try {
    signedUrl = new URL(payload["url"], config.baseUrl);
    if (signedUrl.origin !== new URL(config.baseUrl).origin ||
        !signedUrl.pathname.includes("/object/upload/sign/" + UPLOAD_BUCKET + "/") ||
        !signedUrl.searchParams.has("token")) {
      throw new Error("Unexpected signed URL.");
    }
  } catch {
    return json({ error: "UPLOAD_SIGN_FAILED", message: "Private storage returned an invalid upload URL." }, 502, cookies);
  }

  const storageHostname = new URL(config.baseUrl).hostname;
  const projectRef = storageHostname.endsWith(".supabase.co")
    ? storageHostname.slice(0, -".supabase.co".length)
    : "";
  const tusEndpoint = projectRef && /^[a-z0-9-]+$/i.test(projectRef)
    ? "https://" + projectRef + ".storage.supabase.co/storage/v1/upload/resumable"
    : null;
  const token = signedUrl.searchParams.get("token");
  if (tusEndpoint && !token) {
    return json({ error: "UPLOAD_SIGN_FAILED", message: "Private storage did not return a resumable upload token." }, 502, cookies);
  }
  return json({
    ok: true,
    bucket: UPLOAD_BUCKET,
    path,
    signedUrl: tusEndpoint ? undefined : signedUrl.toString(),
    signedUploadToken: tusEndpoint ? token : undefined,
    tusEndpoint,
    size,
    mimeType,
  }, 200, cookies);
}

async function deleteOwnedUploads(
  runtimeEnv: unknown,
  userId: string,
  paths: unknown,
  cookies: string[],
): Promise<Response> {
  if (!Array.isArray(paths) || paths.length > MAX_UPLOADS_PER_MESSAGE ||
      paths.some(path => typeof path !== "string" || !isOwnedChatUploadPath(userId, path))) {
    return json({ error: "INVALID_UPLOAD_PATH", message: "The upload cleanup request contains an invalid file reference." }, 400, cookies);
  }
  if (paths.length === 0) return json({ ok: true, deleted: 0 }, 200, cookies);

  const config = storageConfig(runtimeEnv);
  if (!config) return json({ error: "UPLOAD_STORAGE_NOT_CONFIGURED", message: "Private file storage is not configured." }, 503, cookies);

  let response: Response;
  try {
    response = await storageRequest(config, "/object/" + UPLOAD_BUCKET, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefixes: paths }),
    });
  } catch {
    return json({ error: "UPLOAD_CLEANUP_FAILED", message: "Temporary uploaded files could not be cleaned up." }, 502, cookies);
  }
  if (!response.ok) {
    console.error("[Dhwani uploads] Supabase could not delete temporary chat uploads:", response.status);
    return json({ error: "UPLOAD_CLEANUP_FAILED", message: "Temporary uploaded files could not be cleaned up." }, 502, cookies);
  }
  return json({ ok: true, deleted: paths.length }, 200, cookies);
}

/** Owner-scoped, short-lived signed uploads to a private Supabase Storage bucket. */
export async function handleUploadsApiRequest(request: Request, runtimeEnv: unknown): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/uploads") return null;

  if (request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED", message: "Use POST to prepare or clean up a private upload." }, 405, []);
  }
  if (!sameOrigin(request)) return json({ error: "ORIGIN_NOT_ALLOWED" }, 403, []);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return json({ error: "JSON_REQUIRED" }, 415, []);
  }

  const session = await getAuthenticatedSession(request, runtimeEnv, 2_500);
  if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503, session.cookies);
  if (!session.user) return json({ error: "AUTH_REQUIRED", message: "Sign in before uploading large chat attachments." }, 401, session.cookies);
  let rateLimit;
  try {
    rateLimit = await consumeSharedRateLimit(runtimeEnv, "uploads", session.user.id, 30, 60);
  } catch {
    return json({ error: "UPLOAD_RATE_LIMIT_UNAVAILABLE", message: "Private upload protection is temporarily unavailable. Please try again shortly." }, 503, session.cookies);
  }
  if (!rateLimit.allowed) {
    return json({ error: "UPLOAD_RATE_LIMITED", message: "Too many upload requests. Wait a minute and try again." }, 429, session.cookies);
  }

  const body = await readRequestBody(request);
  if (!body) return json({ error: "INVALID_JSON", message: "The upload request body is invalid or too large." }, 400, session.cookies);
  if (body["operation"] === "sign") {
    return createSignedUpload(runtimeEnv, session.user.id, body, session.cookies);
  }
  if (body["operation"] === "delete") {
    return deleteOwnedUploads(runtimeEnv, session.user.id, body["paths"], session.cookies);
  }
  return json({ error: "INVALID_UPLOAD_OPERATION" }, 400, session.cookies);
}
