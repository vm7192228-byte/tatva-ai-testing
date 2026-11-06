import { afterEach, describe, expect, it, vi } from "vitest";
import { createKieVideoTask, getKieVideoTask } from "@/lib/kie-video-provider.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KIE server-side video adapter", () => {
  it("fails closed when the server key is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createKieVideoTask({}, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_PROVIDER_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a task with a server-side bearer key and returns only its task id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 200, data: { taskId: "task_123456" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createKieVideoTask(
      { KIE_API_KEY: "server-secret-test" },
      { model: "model-v1", modelInput: { prompt: "  A calm ocean  ", ratio: "16:9", duration: 5 } },
    );

    expect(result).toEqual({ taskId: "task_123456" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.kie.ai/api/v1/jobs/createTask");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-secret-test");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "model-v1",
      input: { prompt: "A calm ocean", ratio: "16:9", duration: 5 },
    });
  });

  it("reads provider secrets from server runtime env bindings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 200, data: { taskId: "task_123456" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createKieVideoTask(
      { env: { KIE_API_KEY: "runtime-binding-secret" } },
      { model: "model-v1", modelInput: { prompt: "A quiet forest" } },
    )).resolves.toEqual({ taskId: "task_123456" });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer runtime-binding-secret");
  });

  it("rejects invalid model, prompt, ratio and duration before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = { KIE_API_KEY: "server-secret-test" };

    await expect(createKieVideoTask(env, { model: "bad model", modelInput: { prompt: "x" } })).rejects.toThrow("KIE_INVALID_INPUT");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: " " } })).rejects.toThrow("KIE_INVALID_INPUT");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "x", unsupported_parameter: "4:3" } })).rejects.toThrow("KIE_INVALID_INPUT");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "x", duration: 99 } })).rejects.toThrow("KIE_INVALID_INPUT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps queued and running provider states without polling", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { state: "waiting" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { state: "generating" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { KIE_API_KEY: "server-secret-test" };

    await expect(getKieVideoTask(env, "task_123456")).resolves.toEqual({ taskId: "task_123456", state: "queued" });
    await expect(getKieVideoTask(env, "task_123456")).resolves.toEqual({ taskId: "task_123456", state: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns only HTTPS public result URLs for completed tasks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://cdn.example/video.mp4", "http://bad.example/video.mp4"] }) },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getKieVideoTask({ KIE_API_KEY: "server-secret-test" }, "task_123456"))
      .resolves.toEqual({ taskId: "task_123456", state: "succeeded", videoUrl: "https://cdn.example/video.mp4" });
  });

  it("rejects malformed task ids and unknown provider states", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getKieVideoTask({ KIE_API_KEY: "server-secret-test" }, "../private"))
      .rejects.toThrow("KIE_INVALID_TASK_ID");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { state: "mystery" } }), { status: 200 }));
    await expect(getKieVideoTask({ KIE_API_KEY: "server-secret-test" }, "task_123456"))
      .rejects.toThrow("KIE_UNKNOWN_TASK_STATE");
  });

  it("maps KIE application-level rate limits returned with HTTP 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 429, msg: "rate limit" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getKieVideoTask({ KIE_API_KEY: "server-secret-test" }, "task_123456")).rejects.toThrow("KIE_RATE_LIMITED");
  });

  it("classifies definitive HTTP rejections separately from uncertain upstream failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("invalid request detail", { status: 400 }))
      .mockResolvedValueOnce(new Response("unauthorized detail", { status: 401 }))
      .mockResolvedValueOnce(new Response("forbidden detail", { status: 403 }))
      .mockResolvedValueOnce(new Response("timeout detail", { status: 408 }))
      .mockResolvedValueOnce(new Response("too early detail", { status: 425 }))
      .mockResolvedValueOnce(new Response("upstream detail", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { KIE_API_KEY: "server-secret-test" };

    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_UPSTREAM_REJECTED");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_AUTH_FAILED");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_AUTH_FAILED");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_UPSTREAM_ERROR");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_UPSTREAM_ERROR");
    await expect(createKieVideoTask(env, { model: "model-v1", modelInput: { prompt: "A calm ocean" } }))
      .rejects.toThrow("KIE_UPSTREAM_ERROR");
  });

  it("normalizes provider HTTP rate limits without exposing response bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("sensitive provider detail", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getKieVideoTask({ KIE_API_KEY: "server-secret-test" }, "task_123456"))
      .rejects.toThrow("KIE_RATE_LIMITED");
  });
});
