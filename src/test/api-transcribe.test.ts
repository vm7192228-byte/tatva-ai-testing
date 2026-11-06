import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
  readOwnedChatUpload: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));
vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));
vi.mock("../lib/uploads-api.server", () => ({
  readOwnedChatUpload: mocks.readOwnedChatUpload,
}));

import { Route } from "../routes/api.transcribe";

type RouteHandler = (args: { request: Request; context: unknown }) => Promise<Response>;
type RouteShape = {
  options: {
    server: {
      handlers: {
        POST: RouteHandler;
      };
    };
  };
};
const post = (Route as unknown as RouteShape).options.server.handlers.POST;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.readOwnedChatUpload.mockReset();
  vi.restoreAllMocks();
});

function transcriptionRequest(signal?: AbortSignal, declaredContentLength?: number) {
  const bytes = new TextEncoder().encode("voice sample");
  // Model the File returned by Request.formData without coupling the test to
  // jsdom/Node FormData implementations. This object intentionally is not a
  // global-realm File; the route validates its Blob/File contract structurally.
  const audioFile = {
    name: "voice-turn.webm",
    size: bytes.byteLength,
    type: "audio/webm",
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  } as File;
  const fields = new Map<string, FormDataEntryValue>([
    ["audio", audioFile],
    ["language", "auto"],
  ]);
  const headers = new Headers({ origin: "https://codeforge.example", "content-type": "multipart/form-data; boundary=test" });
  if (declaredContentLength !== undefined) headers.set("content-length", String(declaredContentLength));
  const request = new Request("https://codeforge.example/api/transcribe", {
    method: "POST",
    headers,
    ...(signal ? { signal } : {}),
  });
  Object.defineProperty(request, "formData", {
    configurable: true,
    value: async () => ({ get: (name: string) => fields.get(name) ?? null }),
  });
  return request;
}

describe("Gemini transcription is disabled until provider terms and audience are approved", () => {
  it("does not use a Gemini key or silently switch to a metered transcription provider", async () => {
    vi.stubEnv("GEMINI_API_KEY", "must-not-be-used-for-transcription");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "false");
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_optional-pollinations-key");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({ request: transcriptionRequest(), context: {} });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shared voice transcription rate limiting", () => {
  it("honors the deployment-wide Supabase limit before calling the transcription provider", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", "https://supabase.example");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-only-service-role-key");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "22222222-2222-4222-8222-222222222222" },
      cookies: [],
    });
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      allowed: false,
      retryAfterSeconds: 37,
      attempts: 11,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({ request: transcriptionRequest(), context: {} });
    const payload = await response.json();
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(payload.error).toBe("RATE_LIMITED");
    expect(url).toBe("https://supabase.example/rest/v1/rpc/cf_allow_transcription_attempt");
    expect(body).toMatchObject({ p_max_attempts: 10, p_window_seconds: 60 });
    expect(body["p_subject_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the configured shared limiter cannot be reached", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", "https://supabase.example");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-only-service-role-key");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "33333333-3333-4333-8333-333333333333" },
      cookies: [],
    });
    const fetchMock = vi.fn(async () => new Response("database unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({ request: transcriptionRequest(), context: {} });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "RATE_LIMIT_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("voice transcription provider configuration", () => {
  it("does not call a metered provider unless explicitly enabled with a server secret key", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "false");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({ request: transcriptionRequest(), context: {} });

    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED" });
    expect(payload.message).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a publishable Pollinations app key for server-side transcription", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "pk_publishable-app-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({ request: transcriptionRequest(), context: {} });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("voice transcription cancellation", () => {
  it("aborts the provider request and does not try backup models after the client stops", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      cookies: [],
    });

    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      providerSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener("abort", () => {
          reject(new DOMException("Provider request aborted.", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = post({
      request: transcriptionRequest(controller.signal),
      context: {},
    });

    const startedOrReturned = await Promise.race([
      vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        .then(() => ({ kind: "provider_started" as const })),
      responsePromise.then(async response => ({
        kind: "returned_early" as const,
        status: response.status,
        body: await response.clone().json(),
      })),
    ]);
    if (startedOrReturned.kind !== "provider_started") {
      throw new Error("Transcription returned before provider fetch: HTTP " +
        startedOrReturned.status + " " + JSON.stringify(startedOrReturned.body));
    }
    expect(providerSignal?.aborted).toBe(false);

    controller.abort();
    const response = await responsePromise;

    expect(providerSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({
      error: "TRANSCRIPTION_CANCELLED",
    });
  });

  it("does not call the transcription provider when the request is already aborted", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    controller.abort();
    const response = await post({
      request: transcriptionRequest(controller.signal),
      context: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(499);
  });
describe("voice transcription payload limits", () => {
  it("rejects oversized multipart bodies before parsing or authenticating", async () => {
    const oversized = transcriptionRequest(undefined, 4_000_001);
    const formData = vi.fn();
    Object.defineProperty(oversized, "formData", { value: formData });
    mocks.getAuthenticatedSession.mockClear();
    const response = await post({ request: oversized, context: {} });
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error).toBe("AUDIO_TOO_LARGE");
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedSession).not.toHaveBeenCalled();
  });
});


describe("private storage voice transcription", () => {
  it("loads an owner-scoped signed audio upload and sends its bytes to Pollinations", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    const userId = "11111111-1111-4111-8111-111111111111";
    const storagePath = userId + "/chat/44444444-4444-4444-8444-444444444444.webm";
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId },
      cookies: [],
    });
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5]);
    mocks.readOwnedChatUpload.mockResolvedValue({
      ok: true,
      bytes: audioBytes,
      mimeType: "audio/webm",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/rest/v1/rpc/cf_allow_transcription_attempt")) {
        return Response.json({ allowed: true, retryAfterSeconds: 0 });
      }
      if (url === "https://gen.pollinations.ai/v1/audio/transcriptions") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_server-only-test-key");
        const body = init?.body as FormData;
        expect(body.get("model")).toBe("openai/whisper-large-v3");
        expect(body.get("response_format")).toBe("json");
        const file = body.get("file");
        expect(file).toBeInstanceOf(Blob);
        expect((file as Blob).type).toBe("audio/webm");
        expect((file as Blob).size).toBe(audioBytes.byteLength);
        return Response.json({ text: "Hello from voice." });
      }
      throw new Error("Unexpected transcription request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://codeforge.example/api/transcribe", {
      method: "POST",
      headers: {
        origin: "https://codeforge.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        storagePath,
        mimeType: "audio/webm",
        size: audioBytes.byteLength,
        language: "auto",
      }),
    });
    const context = {
      SUPABASE_URL: "https://supabase.example",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-storage-key",
    };
    const response = await post({ request, context });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Hello from voice." });
    expect(mocks.readOwnedChatUpload).toHaveBeenCalledWith(
      context,
      userId,
      storagePath,
      "audio/webm",
      audioBytes.byteLength,
      10 * 1024 * 1024,
      request.signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the Pollinations key and explicit opt-in from Cloudflare runtime bindings", async () => {
    for (const name of ["POLLINATIONS_API_KEY", "POLLINATIONS_TRANSCRIPTION_ENABLED"]) {
      vi.stubEnv(name, "");
    }
    const runtimeKey = "sk_worker-only-pollinations-key";
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: "11111111-1111-4111-8111-111111111111" },
      cookies: [],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://gen.pollinations.ai/v1/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + runtimeKey);
      return Response.json({ text: "Worker binding works." });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({
      request: transcriptionRequest(),
      context: { POLLINATIONS_API_KEY: runtimeKey, POLLINATIONS_TRANSCRIPTION_ENABLED: "true" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Worker binding works." });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects guest attempts to reference a private audio object", async () => {
    vi.stubEnv("POLLINATIONS_API_KEY", "sk_server-only-test-key");
    vi.stubEnv("POLLINATIONS_TRANSCRIPTION_ENABLED", "true");
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://codeforge.example/api/transcribe", {
      method: "POST",
      headers: {
        origin: "https://codeforge.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        storagePath: "11111111-1111-4111-8111-111111111111/chat/44444444-4444-4444-8444-444444444444.webm",
        mimeType: "audio/webm",
        size: 5,
        language: "auto",
      }),
    });
    const response = await post({ request, context: {} });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "UPLOAD_AUTH_REQUIRED" });
    expect(mocks.readOwnedChatUpload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

});

describe("voice transcription authentication outage handling", () => {
  it("returns AUTH_UNAVAILABLE instead of downgrading an unverified account to guest mode", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      unavailable: true,
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await post({ request: transcriptionRequest(), context: {} });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.readOwnedChatUpload).not.toHaveBeenCalled();
  });
});
