import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
  createKieVideoTask: vi.fn(),
  getKieVideoTask: vi.fn(),
  claimKieVideoStatusPoll: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));
vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));
vi.mock("../lib/kie-video-provider.server", () => ({
  createKieVideoTask: mocks.createKieVideoTask,
  getKieVideoTask: mocks.getKieVideoTask,
}));
vi.mock("../lib/video-job-polling.server", () => ({
  claimKieVideoStatusPoll: mocks.claimKieVideoStatusPoll,
  KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS: 15,
}));

import { Route } from "../routes/api.video";

type RouteHandler = (args: { request: Request; context: unknown }) => Promise<Response>;
type RouteShape = {
  options: {
    server: {
      handlers: {
        POST: RouteHandler;
        GET: RouteHandler;
      };
    };
  };
};
const handlers = (Route as unknown as RouteShape).options.server.handlers;

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "99999999-9999-4999-8999-999999999999";
const jobId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const supabaseUrl = "https://staging.supabase.example";

function context(overrides: Record<string, unknown> = {}) {
  return {
    env: {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: "staging-only-test-service-key",
      KIE_API_KEY: "test-only-kie-key",
      KIE_WEBHOOK_HMAC_KEY: "test-only-kie-webhook-secret",
      ...overrides,
    },
  };
}

function authenticatedAs(id = userId) {
  mocks.getAuthenticatedSession.mockResolvedValue({
    configured: true,
    user: { id },
    cookies: [],
  });
}

function postRequest(body: Record<string, unknown> = {
  prompt: "A quiet ocean at sunrise",
  aspectRatio: "16:9",
  duration: 5,
}) {
  return new Request("https://codeforge.example/api/video", {
    method: "POST",
    headers: {
      origin: "https://codeforge.example",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function getRequest(query: string) {
  return new Request("https://codeforge.example/api/video?" + query, {
    method: "GET",
    headers: { origin: "https://codeforge.example" },
  });
}

function installDatabaseFetch(
  reservation: Record<string, unknown> = {
    ok: true,
    reused: false,
    jobId,
    status: "reserved",
    planCode: "free",
    used: 1,
    limit: 1,
    remaining: 0,
  },
  ownedJob: Record<string, unknown> | null = null,
  patchStatuses: number[] = [],
  ownedJobAfterPatch?: Record<string, unknown> | null,
  patchRows: Record<string, unknown>[] = [{ id: jobId }],
) {
  const calls: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = [];
  let patchCount = 0;
  let jobReadCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });

    if (url.pathname.endsWith("/rpc/cf_reserve_kie_video_job")) {
      return Response.json(reservation);
    }
    if (method === "PATCH" && url.pathname.endsWith("/cf_video_jobs")) {
      const prefer = new Headers(init?.headers).get("prefer");
      if (prefer === "return=representation") {
        const status = patchStatuses[patchCount++] ?? 200;
        if (status >= 400) return new Response(null, { status });
        return Response.json(patchRows, { status: status === 204 ? 200 : status });
      }
      const status = patchStatuses[patchCount++] ?? 204;
      return new Response(null, { status });
    }
    if (method === "GET" && url.pathname.endsWith("/cf_video_jobs")) {
      const currentJob = jobReadCount++ === 0 ? ownedJob : (ownedJobAfterPatch ?? ownedJob);
      return Response.json(currentJob ? [currentJob] : []);
    }
    return new Response("Unexpected staging database request", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function stubWebCrypto() {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: vi.fn(async () => new Uint8Array(32).buffer),
      importKey: vi.fn(async () => ({})),
      sign: vi.fn(async () => new Uint8Array(32).buffer),
      verify: vi.fn(async () => true),
    },
  });
}

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  mocks.createKieVideoTask.mockReset();
  mocks.getKieVideoTask.mockReset();
  mocks.claimKieVideoStatusPoll.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KIE /api/video route regression coverage", () => {
  it("rejects cross-origin video creation before authentication or database access", async () => {
    const database = installDatabaseFetch();
    const request = new Request("https://codeforge.example/api/video", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ prompt: "A quiet ocean" }),
    });

    const response = await handlers.POST({ request, context: context() });

    expect(response.status).toBe(403);
    expect(mocks.getAuthenticatedSession).not.toHaveBeenCalled();
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("rejects video creation without Origin or same-origin Fetch Metadata", async () => {
    const database = installDatabaseFetch();
    const request = new Request("https://codeforge.example/api/video", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ prompt: "A quiet ocean" }),
    });

    const response = await handlers.POST({ request, context: context() });

    expect(response.status).toBe(403);
    expect(mocks.getAuthenticatedSession).not.toHaveBeenCalled();
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("rejects originless video status polling before account or provider access", async () => {
    const database = installDatabaseFetch();
    const request = new Request("https://codeforge.example/api/video?history=1", {
      method: "GET",
    });

    const response = await handlers.GET({ request, context: context() });

    expect(response.status).toBe(403);
    expect(mocks.getAuthenticatedSession).not.toHaveBeenCalled();
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.getKieVideoTask).not.toHaveBeenCalled();
  });

  it("requires a signed-in owner before reading provider or quota state", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      cookies: [],
    });
    const database = installDatabaseFetch();

    const response = await handlers.POST({ request: postRequest(), context: context() });

    expect(response.status).toBe(401);
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("fails closed when KIE is not configured without reserving credits", async () => {
    authenticatedAs();
    const database = installDatabaseFetch();

    const response = await handlers.POST({
      request: postRequest(),
      context: context({ KIE_API_KEY: "" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.code).toBe("KIE_PROVIDER_NOT_CONFIGURED");
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("keeps KIE task creation and polling available when optional webhook verification is not configured", async () => {
    authenticatedAs();
    const database = installDatabaseFetch();
    mocks.createKieVideoTask.mockResolvedValue({ taskId: "task_123456" });

    const response = await handlers.POST({
      request: postRequest(),
      context: context({ KIE_WEBHOOK_HMAC_KEY: "" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.status).toBe("queued");
    expect(mocks.createKieVideoTask).toHaveBeenCalledOnce();
    const createArgs = mocks.createKieVideoTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(createArgs).not.toHaveProperty("callBackUrl");
    const persisted = database.calls.find(call =>
      call.method === "PATCH" && call.body?.["provider_task_id"] === "task_123456"
    );
    expect(persisted?.body).toMatchObject({
      provider_task_id: "task_123456",
      status: "queued",
    });
  });

  it("rejects unsupported durations before reserving quota or calling KIE", async () => {
    authenticatedAs();
    const database = installDatabaseFetch();

    const response = await handlers.POST({
      request: postRequest({ prompt: "A quiet ocean", duration: 8 }),
      context: context(),
    });

    expect(response.status).toBe(400);
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("reserves quota before submitting one provider task and persists its task id", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch();
    mocks.createKieVideoTask.mockResolvedValue({ taskId: "task_123456" });

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ jobId: "kie_" + jobId, status: "queued", provider: "KIE" });
    expect(database.calls.map(call => call.method)).toEqual(["POST", "PATCH"]);
    expect(database.calls[0]?.url.pathname).toBe("/rest/v1/rpc/cf_reserve_kie_video_job");
    expect(database.calls[0]?.body).toMatchObject({
      p_user_id: userId,
      p_duration_seconds: 5,
      p_idempotency_key: idempotencyKey,
      p_provider_model: "wan/2-7-text-to-video",
    });
    expect(database.calls[0]?.body?.["p_request_fingerprint"]).toMatch(/^[0-9a-f]{64}$/);
    expect(database.calls[1]?.url.search).toContain("id=eq." + jobId);
    expect(database.calls[1]?.body).toMatchObject({
      provider_task_id: "task_123456",
      status: "queued",
    });
    expect(mocks.createKieVideoTask).toHaveBeenCalledOnce();
    expect(mocks.createKieVideoTask).toHaveBeenCalledWith(
      context(),
      {
        model: "wan/2-7-text-to-video",
        modelInput: {
          prompt: "A quiet ocean at sunrise",
          ratio: "16:9",
          duration: 5,
          watermark: false,
        },
        callBackUrl: expect.stringMatching(/^https:\/\/codeforge\.example\/api\/video\?callback=1&jobId=/),
      },
    );
  });

  it("includes a signed KIE callback URL and recovers a task ID after the first database update fails", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch(
      undefined,
      {
        id: jobId,
        user_id: userId,
        provider: "kie",
        provider_task_id: null,
        status: "reserved",
        video_url: null,
      },
      [503, 200],
    );
    mocks.createKieVideoTask.mockResolvedValue({ taskId: "task_123456" });
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "succeeded",
      videoUrl: "https://cdn.example/recovered.mp4",
    });

    const createResponse = await handlers.POST({ request: postRequest(), context: context() });
    const createPayload = await createResponse.json();
    expect(createResponse.status).toBe(202);
    expect(createPayload.status).toBe("submission_pending");
    const createArgs = mocks.createKieVideoTask.mock.calls[0]?.[1] as {
      callBackUrl?: string;
    };
    expect(createArgs.callBackUrl).toMatch(/^https:\/\/codeforge\.example\/api\/video\?callback=1&jobId=/);
    const callbackUrl = new URL(createArgs.callBackUrl!);
    expect(callbackUrl.searchParams.get("expiresAt")).toMatch(/^\d{10,12}$/);
    expect(callbackUrl.searchParams.get("jobToken")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const callbackTimestamp = String(Math.floor(Date.now() / 1_000));
    const callback = new Request(createArgs.callBackUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": callbackTimestamp,
        "x-webhook-signature": "A".repeat(43) + "=",
      },
      body: JSON.stringify({ data: { taskId: "task_123456", state: "success" } }),
    });

    const callbackResponse = await handlers.POST({ request: callback, context: context() });
    const callbackPayload = await callbackResponse.json();

    expect(callbackResponse.status).toBe(200);
    expect(callbackPayload).toMatchObject({ ok: true, received: true, status: "succeeded" });
    expect(mocks.getKieVideoTask).toHaveBeenCalledWith(context(), "task_123456");
    const callbackPatch = database.calls.filter(call => call.method === "PATCH").at(-1);
    expect(callbackPatch?.body).toMatchObject({
      provider_task_id: "task_123456",
      status: "succeeded",
      video_url: "https://cdn.example/recovered.mp4",
    });
  });

  it("keeps a callback-reported success pollable until KIE provides a video URL", async () => {
    stubWebCrypto();
    const database = installDatabaseFetch(undefined, {
      id: jobId,
      user_id: userId,
      provider: "kie",
      provider_task_id: "task_123456",
      status: "queued",
      video_url: null,
    });
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "succeeded",
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const callback = new Request(
      "https://codeforge.example/api/video?callback=1&jobId=" + jobId +
        "&expiresAt=" + (Math.floor(Date.now() / 1_000) + 300) +
        "&jobToken=" + encodeURIComponent("A".repeat(43) + "="),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature": "A".repeat(43) + "=",
        },
        body: JSON.stringify({ data: { taskId: "task_123456", state: "success" } }),
      },
    );

    const response = await handlers.POST({ request: callback, context: context() });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ ok: true, received: true, status: "queued" });
    expect(database.calls[0]?.method).toBe("GET");
    expect(database.calls[1]?.method).toBe("PATCH");
    expect(database.calls[1]?.body).toMatchObject({
      provider_task_id: "task_123456",
      status: "queued",
    });
    expect(database.calls[1]?.body).not.toHaveProperty("video_url");
  });

  it("does not regress an in-progress job when a webhook reports stale queued state", async () => {
    stubWebCrypto();
    const activeJob = {
      id: jobId,
      user_id: userId,
      provider: "kie",
      provider_task_id: "task_123456",
      status: "in_progress",
      video_url: null,
    };
    const database = installDatabaseFetch(undefined, activeJob, [], activeJob, []);
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "queued",
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const callback = new Request(
      "https://codeforge.example/api/video?callback=1&jobId=" + jobId +
        "&expiresAt=" + (Math.floor(Date.now() / 1_000) + 300) +
        "&jobToken=" + encodeURIComponent("A".repeat(43) + "="),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature": "A".repeat(43) + "=",
        },
        body: JSON.stringify({ data: { taskId: "task_123456", state: "queued" } }),
      },
    );

    const response = await handlers.POST({ request: callback, context: context() });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, received: true, status: "in_progress" });
    expect(database.calls.map(call => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(database.calls[1]?.url.searchParams.get("status")).toBe("in.(reserved,queued)");
  });

  it("does not let a stale webhook callback overwrite a poll-completed job", async () => {
    stubWebCrypto();
    const database = installDatabaseFetch(
      undefined,
      {
        id: jobId,
        user_id: userId,
        provider: "kie",
        provider_task_id: "task_123456",
        status: "queued",
        video_url: null,
      },
      [],
      {
        id: jobId,
        user_id: userId,
        provider: "kie",
        provider_task_id: "task_123456",
        status: "succeeded",
        video_url: "https://cdn.example/poll-completed.mp4",
      },
      [],
    );
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "running",
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const callback = new Request(
      "https://codeforge.example/api/video?callback=1&jobId=" + jobId +
        "&expiresAt=" + (Math.floor(Date.now() / 1_000) + 300) + "&jobToken=" + "A".repeat(43) + "=",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature": "A".repeat(43) + "=",
        },
        body: JSON.stringify({ data: { taskId: "task_123456", state: "running" } }),
      },
    );

    const response = await handlers.POST({ request: callback, context: context() });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      received: true,
      status: "succeeded",
      videoUrl: "https://cdn.example/poll-completed.mp4",
    });
    expect(database.calls.map(call => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(database.calls[1]?.url.searchParams.get("status")).toBe("in.(reserved,queued,in_progress)");
  });

  it("preserves a webhook-completed job when the initial KIE submission response arrives late", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch(
      undefined,
      {
        id: jobId,
        user_id: userId,
        provider: "kie",
        provider_task_id: "task_123456",
        status: "succeeded",
        video_url: "https://cdn.example/callback-completed.mp4",
      },
      [],
      undefined,
      [],
    );
    mocks.createKieVideoTask.mockResolvedValue({ taskId: "task_123456" });

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({
      jobId: "kie_" + jobId,
      status: "succeeded",
      videoUrl: "https://cdn.example/callback-completed.mp4",
    });
    expect(database.calls.map(call => call.method)).toEqual(["POST", "PATCH", "GET"]);
    expect(database.calls[1]?.url.searchParams.get("status")).toBe("eq.reserved");
  });

  it("rejects an unsigned KIE callback without reading or changing a job", async () => {
    const database = installDatabaseFetch();
    const request = new Request(
      "https://codeforge.example/api/video?callback=1&jobId=" + jobId,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { taskId: "task_123456" } }),
      },
    );

    const response = await handlers.POST({ request, context: context() });

    expect(response.status).toBe(401);
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.getKieVideoTask).not.toHaveBeenCalled();
  });

  it("reuses a prior idempotent job without creating a duplicate paid provider task", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch({
      ok: true,
      reused: true,
      jobId,
      status: "queued",
      providerTaskId: "task_existing",
      planCode: "free",
    });

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ jobId: "kie_" + jobId, status: "queued", reused: true });
    expect(database.calls).toHaveLength(1);
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("does not submit a provider task when the atomic quota reservation fails", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch({ ok: false, error: "MONTHLY_LIMIT_REACHED" });

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("PLAN_LIMIT_REACHED");
    expect(database.calls).toHaveLength(1);
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("releases quota after a definitive KIE rejection", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch(undefined, null, [204]);
    mocks.createKieVideoTask.mockRejectedValue(new Error("KIE_UPSTREAM_REJECTED"));

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      code: "KIE_PROVIDER_ERROR",
      jobId: "kie_" + jobId,
      status: "failed",
    });
    expect(database.calls.map(call => call.method)).toEqual(["POST", "PATCH"]);
    expect(database.calls[1]?.body).toMatchObject({
      status: "failed",
      provider_error_code: "KIE_UPSTREAM_REJECTED",
    });
    expect(mocks.createKieVideoTask).toHaveBeenCalledOnce();
  });

  it("does not claim quota was released when KIE rejection finalization fails", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch(undefined, null, [503]);
    mocks.createKieVideoTask.mockRejectedValue(new Error("KIE_UPSTREAM_REJECTED"));

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      code: "KIE_RECONCILIATION_PENDING",
      jobId: "kie_" + jobId,
      status: "reconciliation_pending",
    });
    expect(payload.message).toContain("remains reserved for the current UTC month");
    expect(payload.message).toContain("share this job ID with support");
    expect(payload.message).toContain("Do not resubmit");
    expect(database.calls.map(call => call.method)).toEqual(["POST", "PATCH"]);
    expect(database.calls[1]?.body).toMatchObject({
      status: "failed",
      provider_error_code: "KIE_UPSTREAM_REJECTED",
    });
    expect(mocks.createKieVideoTask).toHaveBeenCalledOnce();
  });

  it("keeps an uncertain provider submission reserved instead of retrying a potentially paid task", async () => {
    authenticatedAs();
    stubWebCrypto();
    const database = installDatabaseFetch();
    mocks.createKieVideoTask.mockRejectedValue(new Error("KIE_REQUEST_TIMEOUT"));

    const response = await handlers.POST({ request: postRequest(), context: context() });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({
      code: "KIE_SUBMISSION_UNCONFIRMED",
      jobId: "kie_" + jobId,
      status: "submission_pending",
    });
    expect(database.calls).toHaveLength(1);
    expect(mocks.createKieVideoTask).toHaveBeenCalledOnce();
  });

  it("scopes status lookup to the authenticated owner and does not reveal another user's job", async () => {
    authenticatedAs(otherUserId);
    const database = installDatabaseFetch();

    const response = await handlers.GET({
      request: getRequest("jobId=kie_" + jobId),
      context: context(),
    });
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.message).toContain("not found");
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.url.searchParams.get("user_id")).toBe("eq." + otherUserId);
    expect(mocks.getKieVideoTask).not.toHaveBeenCalled();
  });

  it("does not let a stale running poll overwrite a webhook-completed job", async () => {
    authenticatedAs();
    const database = installDatabaseFetch(
      {},
      {
        id: jobId,
        user_id: userId,
        provider: "kie",
        provider_task_id: "task_123456",
        status: "queued",
        video_url: null,
      },
      [],
      {
        id: jobId,
        user_id: userId,
        provider: "kie",
        provider_task_id: "task_123456",
        status: "succeeded",
        video_url: "https://cdn.example/webhook-completed.mp4",
      },
      [],
    );
    mocks.claimKieVideoStatusPoll.mockResolvedValue(true);
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "running",
    });

    const response = await handlers.GET({
      request: getRequest("jobId=kie_" + jobId),
      context: context(),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "succeeded",
      videoUrl: "https://cdn.example/webhook-completed.mp4",
      provider: "KIE",
    });
    expect(database.calls.map(call => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(database.calls[1]?.url.searchParams.get("status")).toBe("in.(queued,in_progress)");
  });

  it("does not mark a polled KIE job succeeded before a video URL is available", async () => {
    authenticatedAs();
    const database = installDatabaseFetch(undefined, {
      id: jobId,
      user_id: userId,
      provider: "kie",
      provider_task_id: "task_123456",
      status: "in_progress",
      video_url: null,
    });
    mocks.claimKieVideoStatusPoll.mockResolvedValue(true);
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "succeeded",
    });

    const response = await handlers.GET({
      request: getRequest("jobId=kie_" + jobId),
      context: context(),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ status: "in_progress", provider: "KIE" });
    expect(payload.message).toContain("video URL is not available yet");
    expect(database.calls.map(call => call.method)).toEqual(["GET"]);
  });

  it("does not regress an in-progress job when KIE returns a stale queued poll result", async () => {
    authenticatedAs();
    const activeJob = {
      id: jobId,
      user_id: userId,
      provider: "kie",
      provider_task_id: "task_123456",
      status: "in_progress",
      video_url: null,
    };
    const database = installDatabaseFetch(undefined, activeJob, [], activeJob, []);
    mocks.claimKieVideoStatusPoll.mockResolvedValue(true);
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "queued",
    });

    const response = await handlers.GET({
      request: getRequest("jobId=kie_" + jobId),
      context: context(),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ status: "in_progress", provider: "KIE" });
    expect(database.calls.map(call => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(database.calls[1]?.url.searchParams.get("status")).toBe("in.(reserved,queued)");
  });

  it("honors the atomic status-poll cooldown without contacting KIE again", async () => {
    authenticatedAs();
    const database = installDatabaseFetch({}, {
      id: jobId,
      user_id: userId,
      provider: "kie",
      provider_task_id: "task_123456",
      status: "queued",
      video_url: null,
    });
    mocks.claimKieVideoStatusPoll.mockResolvedValue(false);

    const response = await handlers.GET({
      request: getRequest("jobId=kie_" + jobId),
      context: context(),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "queued",
      provider: "KIE",
      retryAfterSeconds: 15,
    });
    expect(database.calls).toHaveLength(1);
    expect(mocks.claimKieVideoStatusPoll).toHaveBeenCalledWith(
      userId,
      jobId,
      expect.any(Function),
    );
    expect(mocks.getKieVideoTask).not.toHaveBeenCalled();
  });

  it("persists a completed KIE result only after the owned job claims its poll slot", async () => {
    authenticatedAs();
    const database = installDatabaseFetch({}, {
      id: jobId,
      user_id: userId,
      provider: "kie",
      provider_task_id: "task_123456",
      status: "in_progress",
      video_url: null,
    });
    mocks.claimKieVideoStatusPoll.mockResolvedValue(true);
    mocks.getKieVideoTask.mockResolvedValue({
      taskId: "task_123456",
      state: "succeeded",
      videoUrl: "https://cdn.example/video.mp4",
    });

    const response = await handlers.GET({
      request: getRequest("jobId=kie_" + jobId),
      context: context(),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "succeeded",
      provider: "KIE",
      videoUrl: "https://cdn.example/video.mp4",
    });
    expect(database.calls.map(call => call.method)).toEqual(["GET", "PATCH"]);
    expect(database.calls[1]?.body).toMatchObject({
      status: "succeeded",
      video_url: "https://cdn.example/video.mp4",
    });
    expect(mocks.getKieVideoTask).toHaveBeenCalledOnce();
  });
});

describe("Video Studio authentication outage handling", () => {
  it("does not report an Auth outage as a signed-out video-creation request", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      unavailable: true,
      cookies: [],
    });
    const database = installDatabaseFetch();

    const response = await handlers.POST({ request: postRequest(), context: context() });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createKieVideoTask).not.toHaveBeenCalled();
  });

  it("does not report an Auth outage as signed-out video history", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      unavailable: true,
      cookies: [],
    });
    const database = installDatabaseFetch();

    const response = await handlers.GET({ request: getRequest("history=1"), context: context() });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    expect(database.fetchMock).not.toHaveBeenCalled();
  });
});
