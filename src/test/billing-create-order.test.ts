import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: authMocks.getAuthenticatedSession,
}));

import { handleBillingApiRequest } from "../lib/billing-api.server";

const userId = "11111111-1111-4111-8111-111111111111";
const checkoutKey = "22222222-2222-4222-8222-222222222222";

const sandboxEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-supabase-key",
  CASHFREE_APP_ID: "TEST_APP_ID",
  CASHFREE_SECRET_KEY: "server-only-cashfree-test-secret",
  CASHFREE_ENVIRONMENT: "sandbox",
  RAZORPAY_PLAN_PRO_MONTHLY_AMOUNT_PAISE: "49900",
};

type DbRow = Record<string, unknown>;

function session() {
  return {
    configured: true,
    user: {
      id: userId,
      email: "creator@example.com",
      displayName: "Creator",
      avatarUrl: "",
    },
    cookies: [],
  };
}

function createOrderRequest(
  key: string | null = checkoutKey,
  phone = "9876543210",
  planCode = "pro_monthly",
) {
  return new Request("https://codeforge.example/api/billing/create-order", {
    method: "POST",
    headers: {
      origin: "https://codeforge.example",
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify({ planCode, phone }),
  });
}

function installBillingFetch(runtimeEnv: Record<string, string>) {
  const rows: DbRow[] = [];
  const cashfreeCalls: Array<{ url: string; headers: Headers; body: DbRow }> = [];
  let sequence = 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body
      ? JSON.parse(String(init.body)) as DbRow
      : undefined;

    if (url.origin === new URL(runtimeEnv["SUPABASE_URL"]!).origin) {
      const path = url.pathname.replace("/rest/v1/", "");

      if (path === "cf_subscriptions" && method === "GET") {
        return Response.json([]);
      }

      if (path === "cf_payment_orders" && method === "POST" && body) {
        const existing = rows.find(row =>
          row["user_id"] === body["user_id"] &&
          row["checkout_idempotency_key"] === body["checkout_idempotency_key"]
        );
        if (existing) return Response.json({ message: "duplicate checkout key" }, { status: 409 });

        const row = {
          id: "payment-order-" + (++sequence),
          ...body,
          cashfree_payment_session_id: null,
          cashfree_cf_order_id: null,
        };
        rows.push(row);
        return Response.json([row], { status: 201 });
      }

      if (path === "cf_payment_orders" && method === "GET") {
        const user = url.searchParams.get("user_id")?.replace(/^eq\./, "");
        const key = url.searchParams.get("checkout_idempotency_key")?.replace(/^eq\./, "");
        return Response.json(rows.filter(row =>
          row["user_id"] === user && row["checkout_idempotency_key"] === key
        ));
      }

      if (path === "cf_payment_orders" && method === "PATCH" && body) {
        const order = url.searchParams.get("cashfree_order_id")?.replace(/^eq\./, "");
        const user = url.searchParams.get("user_id")?.replace(/^eq\./, "");
        const key = url.searchParams.get("checkout_idempotency_key")?.replace(/^eq\./, "");
        const row = rows.find(value =>
          value["cashfree_order_id"] === order &&
          value["user_id"] === user &&
          value["checkout_idempotency_key"] === key
        );
        if (!row) return new Response(null, { status: 204 });
        Object.assign(row, body);
        return new Response(null, { status: 204 });
      }

      return Response.json({ error: "Unexpected database request", path, method }, { status: 500 });
    }

    if (url.hostname === "sandbox.cashfree.com" || url.hostname === "api.cashfree.com") {
      cashfreeCalls.push({ url: url.toString(), headers, body: body ?? {} });
      return Response.json({
        order_id: body?.["order_id"],
        cf_order_id: "cf-provider-order-123",
        payment_session_id: "session_for_" + String(body?.["order_id"]),
      }, { status: 200 });
    }

    return Response.json({ error: "Unexpected request", url: url.toString() }, { status: 500 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { rows, cashfreeCalls, fetchMock };
}

beforeEach(() => {
  authMocks.getAuthenticatedSession.mockResolvedValue(session());
});

afterEach(() => {
  authMocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cashfree checkout idempotency", () => {
  it("rejects billing POSTs without Origin or same-origin Fetch Metadata", async () => {
    const request = new Request("https://codeforge.example/api/billing/create-order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro_monthly", phone: "9876543210" }),
    });

    const response = await handleBillingApiRequest(request, sandboxEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(403);
    expect(payload).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
    expect(authMocks.getAuthenticatedSession).not.toHaveBeenCalled();
  });

  it("accepts a browser billing POST with same-origin Fetch Metadata when Origin is absent", async () => {
    const database = installBillingFetch(sandboxEnv);
    const request = new Request("https://codeforge.example/api/billing/create-order", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "idempotency-key": checkoutKey,
      },
      body: JSON.stringify({ planCode: "pro_monthly", phone: "9876543210" }),
    });

    const response = await handleBillingApiRequest(request, sandboxEnv);

    expect(response?.status).toBe(200);
    expect(database.rows).toHaveLength(1);
    expect(database.cashfreeCalls).toHaveLength(1);
  });

  it("returns the same payment session for a retried checkout key", async () => {
    const database = installBillingFetch(sandboxEnv);

    const first = await handleBillingApiRequest(createOrderRequest(), sandboxEnv);
    const firstPayload = await first!.json();

    const retry = await handleBillingApiRequest(createOrderRequest(), sandboxEnv);
    const retryPayload = await retry!.json();

    expect(first!.status).toBe(200);
    expect(retry!.status).toBe(200);
    expect(firstPayload.orderId).toBe(retryPayload.orderId);
    expect(firstPayload.paymentSessionId).toBe(retryPayload.paymentSessionId);
    expect(firstPayload.mode).toBe("sandbox");
    expect(retryPayload.reused).toBe(true);
    expect(database.rows).toHaveLength(1);
    expect(database.cashfreeCalls).toHaveLength(1);
    expect(database.cashfreeCalls[0]!.url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(database.cashfreeCalls[0]!.headers.get("x-idempotency-key")).toBe(checkoutKey);
    expect(JSON.stringify(firstPayload)).not.toContain(sandboxEnv.CASHFREE_SECRET_KEY);
  });

  it("rejects using one checkout key with different customer details", async () => {
    const database = installBillingFetch(sandboxEnv);

    const first = await handleBillingApiRequest(createOrderRequest(), sandboxEnv);
    expect(first!.status).toBe(200);

    const replay = await handleBillingApiRequest(
      createOrderRequest(checkoutKey, "9876543211"),
      sandboxEnv,
    );
    const payload = await replay!.json();

    expect(replay!.status).toBe(409);
    expect(payload.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(database.rows).toHaveLength(1);
    expect(database.cashfreeCalls).toHaveLength(1);
  });

  it.each(["starter_monthly", "pro_yearly"])(
    "rejects retired legacy plan %s for new checkouts without affecting existing order recovery",
    async (planCode) => {
      const database = installBillingFetch(sandboxEnv);

      const response = await handleBillingApiRequest(
        createOrderRequest(checkoutKey, "9876543210", planCode),
        sandboxEnv,
      );
      const payload = await response!.json();

      expect(response!.status).toBe(400);
      expect(payload.error).toBe("INVALID_PLAN");
      expect(database.rows).toHaveLength(0);
      expect(database.cashfreeCalls).toHaveLength(0);
    },
  );

  it("requires a valid client idempotency key before creating a Cashfree order", async () => {
    const database = installBillingFetch(sandboxEnv);

    const response = await handleBillingApiRequest(createOrderRequest(null), sandboxEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(400);
    expect(payload.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(database.rows).toHaveLength(0);
    expect(database.cashfreeCalls).toHaveLength(0);
  });

  it("uses the live Cashfree endpoint only with production mode and non-TEST credentials", async () => {
    const liveEnv = {
      ...sandboxEnv,
      CASHFREE_APP_ID: "LIVE_APP_ID_FOR_TEST_ONLY",
      CASHFREE_SECRET_KEY: "live-secret-test-placeholder",
      CASHFREE_ENVIRONMENT: "production",
    };
    const database = installBillingFetch(liveEnv);

    const response = await handleBillingApiRequest(createOrderRequest(), liveEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(200);
    expect(payload.mode).toBe("production");
    expect(database.cashfreeCalls[0]!.url).toBe("https://api.cashfree.com/pg/orders");
  });

  it("fails closed when TEST credentials are selected for production mode", async () => {
    const unsafeEnv = {
      ...sandboxEnv,
      CASHFREE_ENVIRONMENT: "production",
    };
    const database = installBillingFetch(unsafeEnv);

    const response = await handleBillingApiRequest(createOrderRequest(), unsafeEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(503);
    expect(payload.error).toBe("CASHFREE_NOT_CONFIGURED");
    expect(database.cashfreeCalls).toHaveLength(0);
  });
  it("returns the existing paid order instead of creating another Cashfree order", async () => {
    const database = installBillingFetch(sandboxEnv);

    const first = await handleBillingApiRequest(createOrderRequest(), sandboxEnv);
    const firstPayload = await first!.json();
    expect(first!.status).toBe(200);
    expect(database.rows).toHaveLength(1);

    database.rows[0]!["status"] = "paid";

    const retry = await handleBillingApiRequest(createOrderRequest(), sandboxEnv);
    const retryPayload = await retry!.json();

    expect(retry!.status).toBe(409);
    expect(retryPayload).toMatchObject({
      error: "CHECKOUT_ALREADY_PROCESSED",
      orderId: firstPayload.orderId,
      orderStatus: "paid",
    });
    expect(database.cashfreeCalls).toHaveLength(1);
    expect(database.rows).toHaveLength(1);
  });

});
