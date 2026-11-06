/**
 * Server-only KIE video task adapter.
 *
 * This module deliberately does not expose credentials to the browser, persist jobs,
 * reserve quota, or enable a media route. Those concerns must be integrated only after
 * the provider/model contract and staging database lifecycle are verified.
 */
type RuntimeEnv = Record<string, unknown>;

const KIE_API_BASE = "https://api.kie.ai/api/v1";
const REQUEST_TIMEOUT_MS = 12_000;

export type KieVideoTaskState = "queued" | "running" | "succeeded" | "failed";

export type KieVideoTask = {
  taskId: string;
  state: KieVideoTaskState;
  videoUrl?: string;
  errorCode?: string;
};

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object"
    ? ((runtimeEnv as RuntimeEnv)[name] ??
      ((runtimeEnv as RuntimeEnv)["env"] && typeof (runtimeEnv as RuntimeEnv)["env"] === "object"
        ? ((runtimeEnv as RuntimeEnv)["env"] as RuntimeEnv)[name]
        : undefined))
    : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configuredKey(runtimeEnv: unknown): string {
  const key = envValue("KIE_API_KEY", runtimeEnv);
  if (!key) throw new Error("KIE_PROVIDER_NOT_CONFIGURED");
  return key;
}

function safeTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{6,160}$/.test(value)) {
    throw new Error("KIE_INVALID_TASK_ID");
  }
  return value;
}

function safeVideoUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

async function readKieJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    if (response.status === 429) throw new Error("KIE_RATE_LIMITED");
    // A definitive client rejection means KIE did not accept a billable task.
    // Keep timeouts and 5xx responses uncertain because the provider may have
    // accepted the request before the connection or upstream failed.
    if (response.status >= 400 && response.status < 500 && ![408, 425].includes(response.status)) {
      throw new Error(response.status === 401 || response.status === 403
        ? "KIE_AUTH_FAILED"
        : "KIE_UPSTREAM_REJECTED");
    }
    throw new Error("KIE_UPSTREAM_ERROR");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("KIE_INVALID_RESPONSE");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("KIE_INVALID_RESPONSE");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["code"] === "number" && record["code"] !== 200) {
    if (record["code"] === 429) throw new Error("KIE_RATE_LIMITED");
    if (record["code"] === 401) throw new Error("KIE_AUTH_FAILED");
    throw new Error("KIE_UPSTREAM_REJECTED");
  }
  return record;
}

function taskData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("KIE_INVALID_RESPONSE");
  }
  return data as Record<string, unknown>;
}

function parseResultUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(safeVideoUrl).filter((url): url is string => Boolean(url));
  if (typeof value !== "string" || value.length > 16_384) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const urls = (parsed as Record<string, unknown>)["resultUrls"];
    return Array.isArray(urls) ? urls.map(safeVideoUrl).filter((url): url is string => Boolean(url)) : [];
  } catch {
    return [];
  }
}

/** Submit a task; callers must reserve quota and persist an idempotent job before invoking. */
export async function createKieVideoTask(
  runtimeEnv: unknown,
  input: {
    model: string;
    modelInput: Record<string, string | number | boolean>;
    callBackUrl?: string;
  },
): Promise<{ taskId: string }> {
  const apiKey = configuredKey(runtimeEnv);
  if (!input || typeof input !== "object" ||
      typeof input.model !== "string" || !/^[A-Za-z0-9._:-]{2,120}$/.test(input.model) ||
      !input.modelInput || typeof input.modelInput !== "object" || Array.isArray(input.modelInput)) {
    throw new Error("KIE_INVALID_INPUT");
  }
  const modelInput = input.modelInput;
  if (input.callBackUrl !== undefined) {
    try {
      const callback = new URL(input.callBackUrl);
      if (callback.protocol !== "https:" || callback.username || callback.password) {
        throw new Error("KIE_INVALID_INPUT");
      }
    } catch {
      throw new Error("KIE_INVALID_INPUT");
    }
  }
  const allowedInputKeys = new Set(["prompt", "negative_prompt", "aspect_ratio", "ratio", "duration", "resolution", "seed", "prompt_extend", "watermark", "image_url", "image_urls", "video_url", "reference_image"]);
  const entries = Object.entries(modelInput);
  if (!entries.length || entries.length > 20 || entries.some(([key, value]) =>
    !allowedInputKeys.has(key) ||
    !(typeof value === "string" || typeof value === "number" || typeof value === "boolean") ||
    (typeof value === "string" && value.length > 2048) ||
    (typeof value === "number" && !Number.isFinite(value)))) {
    throw new Error("KIE_INVALID_INPUT");
  }
  if (typeof modelInput["prompt"] !== "string" || !modelInput["prompt"].trim() || modelInput["prompt"].length > 1800) {
    throw new Error("KIE_INVALID_INPUT");
  }
  if (modelInput["duration"] !== undefined) {
    const duration = typeof modelInput["duration"] === "number" ? modelInput["duration"] : Number(modelInput["duration"]);
    if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new Error("KIE_INVALID_INPUT");
  }

  let response: Response;
  try {
    response = await fetch(KIE_API_BASE + "/jobs/createTask", {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        ...(input.callBackUrl ? { callBackUrl: input.callBackUrl } : {}),
        input: {
          ...modelInput,
          prompt: (modelInput["prompt"] as string).trim(),
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("KIE_REQUEST_TIMEOUT");
    }
    throw new Error("KIE_UNREACHABLE");
  }

  const payload = await readKieJson(response);
  const data = taskData(payload);
  return { taskId: safeTaskId(data["taskId"]) };
}

/** Fetch one task status; never polls or waits inside a server request. */
export async function getKieVideoTask(
  runtimeEnv: unknown,
  taskId: string,
): Promise<KieVideoTask> {
  const apiKey = configuredKey(runtimeEnv);
  const id = safeTaskId(taskId);
  let response: Response;
  try {
    response = await fetch(KIE_API_BASE + "/jobs/recordInfo?taskId=" + encodeURIComponent(id), {
      method: "GET",
      headers: {
        authorization: "Bearer " + apiKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("KIE_REQUEST_TIMEOUT");
    }
    throw new Error("KIE_UNREACHABLE");
  }

  const payload = await readKieJson(response);
  const data = taskData(payload);
  const rawState = typeof data["state"] === "string" ? data["state"].toLowerCase() : "";
  if (["waiting", "queuing", "pending"].includes(rawState)) {
    return { taskId: id, state: "queued" };
  }
  if (["generating", "processing", "running"].includes(rawState)) {
    return { taskId: id, state: "running" };
  }
  if (["fail", "failed", "error"].includes(rawState)) {
    return {
      taskId: id,
      state: "failed",
      ...(typeof data["failCode"] === "string" ? { errorCode: data["failCode"].slice(0, 100) } : {}),
    };
  }
  if (["success", "succeeded", "completed"].includes(rawState)) {
    const urls = parseResultUrls(data["resultJson"] ?? data["resultUrls"]);
    const videoUrl = urls[0];
    if (!videoUrl) throw new Error("KIE_RESULT_URL_MISSING");
    return { taskId: id, state: "succeeded", videoUrl };
  }
  throw new Error("KIE_UNKNOWN_TASK_STATE");
}
