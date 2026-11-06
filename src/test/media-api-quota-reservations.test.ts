import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMediaApiRequest } from "@/lib/media-api.server";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_ANON_KEY: "supabase-anon-test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  CODEFORGE_GATEWAY_URL: "https://primary-gateway.example/v1",
  CODEFORGE_GATEWAY_IMAGE_MODEL: "pollinations/reviewed-test-model",
};
const reservationId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function imageRequest(userId: string, idempotencyKey: string) {
  return new Request("https://codeforge.example/api/media", {
    method: "POST",
    headers: {
      origin: "https://codeforge.example",
      cookie: "cf_access=valid-test-session",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      type: "image",
      prompt: "A quiet mountain lake at sunrise",
    }),
  });
}

function installMediaFetch(options: {
  userId: string;
  reservation: Record<string, unknown>;
  provider: () => Response;
  gatewayProviders?: Record<string, () => Response>;
  fallbackProvider?: () => Response;
  finalization?: Record<string, unknown>;
}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const finalizationActions: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: options.userId, email: "creator@example.com" });
    }
    if (url.endsWith("/rpc/cf_reserve_usage_quota")) {
      return Response.json(options.reservation);
    }
    if (url.endsWith("/images/generations")) {
      const gatewayProvider = options.gatewayProviders?.[new URL(url).origin];
      return gatewayProvider ? gatewayProvider() : options.provider();
    }
    if (url.includes("api.cloudflare.com/client/v4/accounts/")) {
      if (!options.fallbackProvider) throw new Error("Unexpected Cloudflare fallback request");
      return options.fallbackProvider();
    }
    if (url.endsWith("/rpc/cf_finalize_usage_quota")) {
      const body = JSON.parse(String(init?.body)) as { p_action?: string };
      if (body.p_action) finalizationActions.push(body.p_action);
      return Response.json(options.finalization ?? { ok: true, status: body.p_action === "commit" ? "committed" : "released" });
    }
    throw new Error("Unexpected test fetch: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, finalizationActions };
}

describe("image generation quota reservation lifecycle", () => {
  it("fails closed before reserving quota when the image model is missing or auto", async () => {
    const { calls } = installMediaFetch({
      userId: "10101010-1010-4010-8010-101010101010",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 20, used: 0, remaining: 20 },
      provider: () => Response.json({ error: "should not be called" }, { status: 500 }),
    });
    const response = await handleMediaApiRequest(
      imageRequest("10101010-1010-4010-8010-101010101010", "12121212-1212-4212-8212-121212121212"),
      { ...runtimeEnv, CODEFORGE_GATEWAY_IMAGE_MODEL: "auto" },
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "IMAGE_MODEL_NOT_CONFIGURED" });
    expect(calls.some(call => call.url.endsWith("/rpc/cf_reserve_usage_quota"))).toBe(false);
    expect(calls.some(call => call.url.endsWith("/images/generations"))).toBe(false);
  });

  it("rejects image-generation POSTs without a verifiable same-origin signal", async () => {
    const response = await handleMediaApiRequest(new Request("https://codeforge.example/api/media", {
      method: "POST",
      headers: {
        cookie: "cf_access=valid-test-session",
        "content-type": "application/json",
        "idempotency-key": "33333333-3333-4333-8333-333333333333",
      },
      body: JSON.stringify({ type: "image", prompt: "A quiet mountain lake at sunrise" }),
    }), runtimeEnv);

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
  });

  it("releases the reservation when the provider reports a rate limit", async () => {
    const { calls, finalizationActions } = installMediaFetch({
      userId: "11111111-1111-4111-8111-111111111111",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => Response.json({ error: "provider busy" }, { status: 429 }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(finalizationActions).toEqual(["release"]);
    expect(calls.some(call => call.url.endsWith("/images/generations"))).toBe(true);
  });

  it("commits the reservation after receiving a valid image response", async () => {
    const { finalizationActions } = installMediaFetch({
      userId: "44444444-4444-4444-8444-444444444444",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => new Response("generated-image-bytes", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("image/png");
    expect(await response!.text()).toBe("generated-image-bytes");
    expect(finalizationActions).toEqual(["commit"]);
  });

  it("releases usage when the provider returns an empty image body", async () => {
    const { finalizationActions } = installMediaFetch({
      userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => new Response(null, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "0" },
      }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);
    expect((await response!.json()).error).toBe("CODEFORGE_GATEWAY_IMAGE_BAD_RESPONSE");
    expect(finalizationActions).toEqual(["release"]);
  });

  it("rejects whitespace-only base64 image data and releases the reserved credit", async () => {
    const { finalizationActions } = installMediaFetch({
      userId: "abababab-abab-4bab-8bab-abababababab",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => Response.json({ data: [{ b64_json: " ".repeat(120) }] }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("abababab-abab-4bab-8bab-abababababab", "acacacac-acac-4cac-8cac-acacacacacac"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);
    expect((await response!.json()).error).toBe("CODEFORGE_GATEWAY_IMAGE_BAD_RESPONSE");
    expect(finalizationActions).toEqual(["release"]);
  });

  it("does not call the image provider when the monthly allowance is exhausted", async () => {
    const { calls, finalizationActions } = installMediaFetch({
      userId: "66666666-6666-4666-8666-666666666666",
      reservation: {
        allowed: false,
        error: "MONTHLY_LIMIT_REACHED",
        planCode: "pro_monthly",
        limit: 25,
        used: 25,
        remaining: 0,
      },
      provider: () => new Response("must not be called", { status: 500 }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(402);
    expect(calls.some(call => call.url.endsWith("/images/generations"))).toBe(false);
    expect(finalizationActions).toEqual([]);
  });

  it("fails closed on an unknown quota RPC error without calling the provider", async () => {
    const { calls, finalizationActions } = installMediaFetch({
      userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      reservation: { allowed: false, error: "UNEXPECTED_DATABASE_ERROR" },
      provider: () => new Response("must not be called", { status: 500 }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect((await response!.json()).error).toBe("IMAGE_USAGE_UNAVAILABLE");
    expect(calls.some(call => call.url.endsWith("/images/generations"))).toBe(false);
    expect(finalizationActions).toEqual([]);
  });

  it("rejects a repeated idempotency key without starting another provider request", async () => {
    const { calls } = installMediaFetch({
      userId: "88888888-8888-4888-8888-888888888888",
      reservation: { allowed: false, error: "IDEMPOTENCY_KEY_REUSED", status: "committed" },
      provider: () => new Response("must not be called", { status: 500 }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(409);
    expect(calls.some(call => call.url.endsWith("/images/generations"))).toBe(false);
  });

  it("does not return generated image bytes when quota finalization fails", async () => {
    const { finalizationActions } = installMediaFetch({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => new Response("generated-image-bytes", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      finalization: { ok: false, error: "RESERVATION_EXPIRED" },
    });

    const response = await handleMediaApiRequest(
      imageRequest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      runtimeEnv,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect((await response!.json()).error).toBe("IMAGE_QUOTA_FINALIZATION_FAILED");
    expect(finalizationActions).toEqual(["commit"]);
  });


  it("tries all configured private image gateways before the Cloudflare fallback", async () => {
    const multiGatewayEnv = {
      ...runtimeEnv,
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-one.example/v1",
      CODEFORGE_GATEWAY_FALLBACK_2_URL: "https://backup-two.example/v1",
      CODEFORGE_GATEWAY_FALLBACK_3_URL: "https://backup-three.example/v1",
    };
    const { calls, finalizationActions } = installMediaFetch({
      userId: "66666666-6666-4666-8666-666666666666",
      reservation: { allowed: true, reservationId, planCode: "creator_monthly", limit: 60, used: 1, remaining: 59 },
      provider: () => Response.json({ error: "primary unavailable" }, { status: 503 }),
      gatewayProviders: {
        "https://backup-one.example": () => Response.json({ error: "backup one unavailable" }, { status: 503 }),
        "https://backup-two.example": () => new Response("backup-two-image-bytes", {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      },
    });

    const response = await handleMediaApiRequest(
      imageRequest("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"),
      multiGatewayEnv,
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("backup-two-image-bytes");
    expect(calls.filter(call => call.url.endsWith("/images/generations")).map(call => new URL(call.url).origin)).toEqual([
      "https://primary-gateway.example",
      "https://backup-one.example",
      "https://backup-two.example",
    ]);
    expect(finalizationActions).toEqual(["commit"]);
  });

  it("uses Cloudflare only after the private CodeForge gateway fails, then commits one image credit", async () => {
    const { calls, finalizationActions } = installMediaFetch({
      userId: "abababab-abab-4bab-8bab-abababababab",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => Response.json({ error: "primary unavailable" }, { status: 503 }),
      fallbackProvider: () => new Response("cloudflare-image-bytes", {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("abababab-abab-4bab-8bab-abababababab", "acacacac-acac-4cac-8cac-acacacacacac"),
      {
        ...runtimeEnv,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "server-only-test-token",
      },
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("x-codeforge-media-provider")).toBe("Cloudflare Workers AI");
    expect(await response!.text()).toBe("cloudflare-image-bytes");
    const providerCalls = calls.filter(call => call.url.endsWith("/images/generations") || call.url.includes("api.cloudflare.com/client/v4/accounts/"));
    expect(providerCalls.map(call => call.url.includes("api.cloudflare.com") ? "cloudflare" : "codeforge_gateway")).toEqual(["codeforge_gateway", "cloudflare"]);
    expect(finalizationActions).toEqual(["commit"]);
  });

  it("releases the reservation when both the primary and configured fallback fail", async () => {
    const { finalizationActions } = installMediaFetch({
      userId: "dededede-dede-4ede-8ede-dededededede",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => Response.json({ error: "primary unavailable" }, { status: 503 }),
      fallbackProvider: () => Response.json({ error: "fallback unavailable" }, { status: 503 }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("dededede-dede-4ede-8ede-dededededede", "efefefef-efef-4fef-8fef-efefefefefef"),
      {
        ...runtimeEnv,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "server-only-test-token",
      },
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);
    expect((await response!.json()).error).toBe("IMAGE_PROVIDERS_UNAVAILABLE");
    expect(finalizationActions).toEqual(["release"]);
  });
  it("does not fail over to Cloudflare when the private gateway rejects the prompt", async () => {
    const { calls, finalizationActions } = installMediaFetch({
      userId: "12121212-1212-4212-8212-121212121212",
      reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 25, used: 1, remaining: 24 },
      provider: () => Response.json({ error: "prompt rejected" }, { status: 422 }),
      fallbackProvider: () => new Response("must not be called", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });

    const response = await handleMediaApiRequest(
      imageRequest("12121212-1212-4212-8212-121212121212", "13131313-1313-4313-8313-131313131313"),
      {
        ...runtimeEnv,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "server-only-test-token",
      },
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(502);
    expect(calls.some(call => call.url.endsWith("/images/generations"))).toBe(true);
    expect(calls.some(call => call.url.includes("api.cloudflare.com/client/v4/accounts/"))).toBe(false);
    expect(finalizationActions).toEqual(["release"]);
  });

  it("never routes around a missing or exhausted provider image budget", async () => {
    for (const scenario of [
      { code: "PROVIDER_IMAGE_BUDGET_NOT_CONFIGURED", status: 503 },
      { code: "PROVIDER_IMAGE_BUDGET_EXCEEDED", status: 429 },
    ]) {
      const multiGatewayEnv = {
        ...runtimeEnv,
        CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-one.example/v1",
        CODEFORGE_GATEWAY_FALLBACK_2_URL: "https://backup-two.example/v1",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "server-only-test-token",
      };
      const { calls, finalizationActions } = installMediaFetch({
        userId: "14141414-1414-4414-8414-141414141414",
        reservation: { allowed: true, reservationId, planCode: "pro_monthly", limit: 20, used: 0, remaining: 20 },
        provider: () => Response.json({
          error: { code: scenario.code, message: "Provider image budget blocked." },
        }, { status: scenario.status }),
        gatewayProviders: {
          "https://backup-one.example": () => new Response("must-not-call-backup", {
            status: 200, headers: { "content-type": "image/png" },
          }),
          "https://backup-two.example": () => new Response("must-not-call-backup", {
            status: 200, headers: { "content-type": "image/png" },
          }),
        },
        fallbackProvider: () => new Response("must-not-call-cloudflare", {
          status: 200, headers: { "content-type": "image/jpeg" },
        }),
      });

      const response = await handleMediaApiRequest(
        imageRequest("14141414-1414-4414-8414-141414141414", crypto.randomUUID()),
        multiGatewayEnv,
      );
      const payload = await response?.json() as { error?: string; code?: string };

      expect(response?.status).toBe(scenario.status === 429 ? 429 : 502);
      expect(payload.error).toBe("PROVIDER_IMAGE_BUDGET_BLOCKED");
      expect(payload.code).toBe(scenario.code);
      expect(calls.filter(call => call.url.endsWith("/images/generations"))).toHaveLength(1);
      expect(calls.some(call => call.url.includes("api.cloudflare.com/client/v4/accounts/"))).toBe(false);
      expect(finalizationActions).toEqual(["release"]);
    }
  });

});
