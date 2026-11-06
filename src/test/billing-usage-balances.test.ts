import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));

import { handleBillingApiRequest } from "../lib/billing-api.server";

const userId = "11111111-1111-4111-8111-111111111111";
const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

function session(user: boolean) {
  return {
    configured: true,
    user: user ? { id: userId, email: "user@example.com", displayName: "User", avatarUrl: "" } : null,
    cookies: [],
  };
}

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("billing monthly usage balances", () => {
  it("returns file and social action balances from the same monthly usage ledger", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(session(true));
    const limits: Record<string, number> = {
      image_generation: 2,
      file_analysis: 3,
      social_analysis: 3,
      social_edit: 1,
    };
    const used: Record<string, number> = {
      image_generation: 1,
      file_analysis: 2,
      social_analysis: 3,
      social_edit: 1,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cf_subscriptions?")) return Response.json([]);
      if (url.includes("/cf_plan_limits?")) {
        const feature = new URL(url).searchParams.get("feature_code")?.replace("eq.", "") ?? "";
        return Response.json(Object.hasOwn(limits, feature) ? [{ monthly_limit: limits[feature] }] : []);
      }
      if (url.includes("/rpc/cf_video_quota_status")) {
        return Response.json({ paid: false, planCode: "free", used: 1, limit: 1, remaining: 0 });
      }
      if (url.includes("/cf_usage_events?")) {
        const feature = new URL(url).searchParams.get("feature_code")?.replace("eq.", "") ?? "";
        const count = used[feature] ?? 0;
        return new Response(JSON.stringify(count ? [{ id: "usage-row" }] : []), {
          status: 200,
          headers: { "content-type": "application/json", "content-range": count ? "0-0/" + count : "*/0" },
        });
      }
      if (url.includes("/cf_usage_reservations?")) {
        const feature = new URL(url).searchParams.get("feature_code")?.replace("eq.", "") ?? "";
        const count = feature === "image_generation" || feature === "file_analysis" ? 1 : 0;
        return new Response(JSON.stringify(count ? [{ id: "reservation-row" }] : []), {
          status: 200,
          headers: { "content-type": "application/json", "content-range": count ? "0-0/" + count : "*/0" },
        });
      }
      throw new Error("Unexpected billing query: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleBillingApiRequest(
      new Request("https://app.example/api/billing/usage"),
      runtimeEnv,
    );
    const payload = await response?.json() as any;

    expect(response?.status).toBe(200);
    expect(payload.photo).toMatchObject({ used: 1, reserved: 1, limit: 2, remaining: 0 });
    expect(payload.fileAnalysis).toMatchObject({ used: 2, reserved: 1, limit: 3, remaining: 0 });
    expect(payload.socialAnalysis).toMatchObject({ used: 3, limit: 3, remaining: 0 });
    expect(payload.socialEdit).toMatchObject({ used: 1, limit: 1, remaining: 0 });
    expect(payload.aiChat.mode).toBe("free-provider-usage");
    expect(payload.video).toMatchObject({ used: 1, limit: 1, remaining: 0, unit: "credit" });
  });

  it("returns safe free-plan preview balances without querying the database for guests", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue(session(false));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleBillingApiRequest(
      new Request("https://app.example/api/billing/usage"),
      runtimeEnv,
    );
    const payload = await response?.json() as any;

    expect(response?.status).toBe(200);
    expect(payload.authenticated).toBe(false);
    expect(payload.video).toMatchObject({ limit: 1, remaining: 1, mode: "sign-in-required" });
    expect(payload.fileAnalysis).toMatchObject({ limit: 3, remaining: 3, mode: "sign-in-required" });
    expect(payload.socialAnalysis).toMatchObject({ limit: 3, remaining: 3, mode: "sign-in-required" });
    expect(payload.socialEdit).toMatchObject({ limit: 1, remaining: 1, mode: "sign-in-required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
