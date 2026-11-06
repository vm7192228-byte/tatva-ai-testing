import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
const authMocks = vi.hoisted(() => ({ getAuthenticatedSession: vi.fn() }));
vi.mock("../lib/auth-api.server", () => ({ getAuthenticatedSession: authMocks.getAuthenticatedSession }));
import { consumeRequestQuota, deriveUsageReservationKey, finalizeUsageQuota, reserveUsageQuota } from "@/lib/usage-limits.server";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
};
const userId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  authMocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stable per-unit usage idempotency keys", () => {
  it("derives a valid, stable and distinct UUID for each file in one chat request", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const first = await deriveUsageReservationKey(idempotencyKey, "file_analysis", 0);
    const retry = await deriveUsageReservationKey(idempotencyKey, "file_analysis", 0);
    const second = await deriveUsageReservationKey(idempotencyKey, "file_analysis", 1);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first).toBe(retry);
    expect(first).not.toBe(second);
  });

  it("rejects invalid request keys and unsafe file indexes", async () => {
    vi.stubGlobal("crypto", webcrypto);
    await expect(deriveUsageReservationKey("not-a-uuid", "file_analysis", 0)).rejects.toThrow("INVALID_USAGE_RESERVATION_KEY");
    await expect(deriveUsageReservationKey(idempotencyKey, "file_analysis", -1)).rejects.toThrow("INVALID_USAGE_RESERVATION_KEY");
  });
});

describe("image usage quota reservations", () => {
  it("reserves usage with the user, feature and idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        allowed: true,
        reservationId,
        planCode: "pro_monthly",
        limit: 25,
        used: 1,
        remaining: 24,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reserveUsageQuota(runtimeEnv, userId, "image_generation", idempotencyKey);

    expect(result).toEqual({
      allowed: true,
      reservationId,
      planCode: "pro_monthly",
      limit: 25,
      used: 1,
      remaining: 24,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://supabase.example/rest/v1/rpc/cf_reserve_usage_quota");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      p_user_id: userId,
      p_feature_code: "image_generation",
      p_idempotency_key: idempotencyKey,
    });
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer service-role-test-key");
  });

  it("preserves a monthly limit denial without inventing a reservation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      allowed: false,
      error: "MONTHLY_LIMIT_REACHED",
      planCode: "pro_monthly",
      limit: 25,
      used: 25,
      remaining: 0,
    })));

    const result = await reserveUsageQuota(runtimeEnv, userId, "image_generation", idempotencyKey);

    expect(result.allowed).toBe(false);
    expect(result.error).toBe("MONTHLY_LIMIT_REACHED");
    expect(result.reservationId).toBeUndefined();
    expect(result.remaining).toBe(0);
  });

  it("rejects a success response that omits the reservation identifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ allowed: true })));

    await expect(
      reserveUsageQuota(runtimeEnv, userId, "image_generation", idempotencyKey),
    ).rejects.toThrow("USAGE_QUOTA_RESERVATION_INVALID_RESPONSE");
  });

  it("commits a reservation through the protected finalize RPC", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ ok: true, status: "committed" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeUsageQuota(runtimeEnv, userId, reservationId, "commit");

    expect(result).toEqual({ ok: true, status: "committed" });
    expect(calls[0]!.url).toBe("https://supabase.example/rest/v1/rpc/cf_finalize_usage_quota");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      p_user_id: userId,
      p_reservation_id: reservationId,
      p_action: "commit",
    });
  });

  it("supports an explicit release after a provider failure", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return Response.json({ ok: true, status: "released" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeUsageQuota(runtimeEnv, userId, reservationId, "release");

    expect(result).toEqual({ ok: true, status: "released" });
    expect(JSON.parse(String(calls[0]!.init?.body)).p_action).toBe("release");
  });

  it("does not treat an unsuccessful finalize RPC as a successful release", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: "RESERVATION_EXPIRED",
    })));

    const result = await finalizeUsageQuota(runtimeEnv, userId, reservationId, "release");

    expect(result).toEqual({ ok: false, error: "RESERVATION_EXPIRED" });
  });

  it("fails closed when the reservation endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("database offline", { status: 503 })));

    await expect(
      reserveUsageQuota(runtimeEnv, userId, "image_generation", idempotencyKey),
    ).rejects.toThrow("USAGE_QUOTA_RESERVATION_FAILED");
  });
});


describe("request quota authentication outage handling", () => {
  it("returns AUTH_UNAVAILABLE instead of treating an account outage as sign-in required", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      unavailable: true,
      cookies: [],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await consumeRequestQuota(
      new Request("https://codeforge.example/api/quota", {
        headers: { cookie: "cf_access=existing-access-token; cf_refresh=existing-refresh-token" },
      }),
      runtimeEnv,
      "image_generation",
    );

    expect(result.response?.status).toBe(503);
    expect(await result.response?.json()).toMatchObject({ error: "AUTH_UNAVAILABLE" });
    expect(result.decision).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
