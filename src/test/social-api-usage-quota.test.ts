import { afterEach, describe, expect, it, vi } from "vitest";

const quotaMocks = vi.hoisted(() => ({
  reserveUsageQuota: vi.fn(),
  finalizeUsageQuota: vi.fn(),
}));

vi.mock("../lib/usage-limits.server", () => ({
  reserveUsageQuota: quotaMocks.reserveUsageQuota,
  finalizeUsageQuota: quotaMocks.finalizeUsageQuota,
}));

import { withSocialUsageQuota } from "../lib/social-api.server";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};
const userId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  quotaMocks.reserveUsageQuota.mockReset();
  quotaMocks.finalizeUsageQuota.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setupQuota(options: { allowed?: boolean; error?: string } = {}) {
  const actions: string[] = [];
  quotaMocks.reserveUsageQuota.mockResolvedValue(options.allowed === false
    ? { allowed: false, error: options.error ?? "MONTHLY_LIMIT_REACHED", planCode: "free", limit: 1, used: 1, remaining: 0 }
    : { allowed: true, reservationId, status: "reserved", planCode: "free", limit: 3, used: 1, remaining: 2 });
  quotaMocks.finalizeUsageQuota.mockImplementation(async (
    _runtimeEnv: unknown,
    _userId: string,
    _reservationId: string,
    action: "commit" | "release",
  ) => {
    actions.push(action);
    return { ok: true, status: action === "commit" ? "committed" : "released" };
  });
  return { actions };
}

function request() {
  return new Request("https://app.example/api/social/youtube/channel", {
    headers: { "idempotency-key": idempotencyKey },
  });
}

describe("social usage reservation lifecycle", () => {
  it("commits an analysis reservation only after a successful provider response", async () => {
    const { actions } = setupQuota();
    const operation = vi.fn(async () => Response.json({ ok: true, channel: "Test" }));

    const response = await withSocialUsageQuota(request(), runtimeEnv, userId, "social_analysis", operation);

    expect(response.status).toBe(200);
    expect(actions).toEqual(["commit"]);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(quotaMocks.reserveUsageQuota).toHaveBeenCalledWith(runtimeEnv, userId, "social_analysis", idempotencyKey);
  });

  it("releases a read-only analysis reservation when the provider returns an error", async () => {
    const { actions } = setupQuota();
    const operation = vi.fn(async () => Response.json({ error: "rate limited" }, { status: 429 }));

    const response = await withSocialUsageQuota(request(), runtimeEnv, userId, "social_analysis", operation);

    expect(response.status).toBe(429);
    expect(actions).toEqual(["release"]);
  });

  it("commits a write reservation conservatively when the provider returns a server error", async () => {
    const { actions } = setupQuota();
    const operation = vi.fn(async () => Response.json({ error: "response uncertain" }, { status: 502 }));

    const response = await withSocialUsageQuota(request(), runtimeEnv, userId, "social_edit", operation, true);

    expect(response.status).toBe(502);
    expect(actions).toEqual(["commit"]);
  });

  it("releases a write reservation when the provider returns a definitive client rejection", async () => {
    const { actions } = setupQuota();
    const operation = vi.fn(async () => Response.json({ error: "invalid request" }, { status: 400 }));

    const response = await withSocialUsageQuota(request(), runtimeEnv, userId, "social_edit", operation, true);

    expect(response.status).toBe(400);
    expect(actions).toEqual(["release"]);
  });

  it("does not call a provider when the monthly allowance is exhausted", async () => {
    const { actions } = setupQuota({ allowed: false });
    const operation = vi.fn(async () => Response.json({ ok: true }));

    const response = await withSocialUsageQuota(request(), runtimeEnv, userId, "social_edit", operation, true);
    const payload = await response.json() as { error?: string; feature?: string };

    expect(response.status).toBe(402);
    expect(payload.error).toBe("PLAN_LIMIT_REACHED");
    expect(payload.feature).toBe("social_edit");
    expect(operation).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    expect(quotaMocks.finalizeUsageQuota).not.toHaveBeenCalled();
  });

  it("rejects a repeated idempotency key without invoking the provider", async () => {
    setupQuota({ allowed: false, error: "IDEMPOTENCY_KEY_REUSED" });
    const operation = vi.fn(async () => Response.json({ ok: true }));

    const response = await withSocialUsageQuota(request(), runtimeEnv, userId, "social_edit", operation, true);
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toBe("SOCIAL_REQUEST_ALREADY_PROCESSED");
    expect(operation).not.toHaveBeenCalled();
  });

  it("releases a write reservation after a definitive thrown provider rejection", async () => {
    const { actions } = setupQuota();
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("provider rejected request"), { status: 403 });
    });

    await expect(withSocialUsageQuota(request(), runtimeEnv, userId, "social_edit", operation, true))
      .rejects.toThrow("provider rejected request");

    expect(actions).toEqual(["release"]);
  });

  it("commits a write reservation after an ambiguous network failure", async () => {
    const { actions } = setupQuota();
    const operation = vi.fn(async () => {
      throw new Error("socket closed");
    });

    await expect(withSocialUsageQuota(request(), runtimeEnv, userId, "social_edit", operation, true))
      .rejects.toThrow("socket closed");

    expect(actions).toEqual(["commit"]);
  });
});
