import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: authMocks.getAuthenticatedSession,
}));

import { handleBillingApiRequest } from "../lib/billing-api.server";

const userId = "11111111-1111-4111-8111-111111111111";
const orderId = "cf_order_recovery_123";
const paymentId = "payment_recovery_123";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  CASHFREE_APP_ID: "TEST_APP_ID",
  CASHFREE_SECRET_KEY: "cashfree-test-secret",
  CASHFREE_ENVIRONMENT: "sandbox",
};

type SubscriptionRow = Record<string, unknown>;

function installDatabase(options: {
  failFirstActivationRpc?: boolean;
  initialSubscription?: boolean;
  initialOrderStatus?: string;
  initialPaymentId?: string | null;
} = {}) {
  let order: Record<string, unknown> = {
    cashfree_order_id: orderId,
    plan_code: "pro_monthly",
    status: options.initialOrderStatus ?? "paid",
    user_id: userId,
    amount_paise: 49900,
    currency: "INR",
    cashfree_payment_id: options.initialPaymentId === undefined ? paymentId : options.initialPaymentId,
  };
  const subscriptions: SubscriptionRow[] = options.initialSubscription ? [{
    id: "subscription_123",
    user_id: userId,
    plan_code: "pro_monthly",
    status: "active",
    cashfree_order_id: orderId,
    cashfree_payment_id: paymentId,
  }] : [];
  const refunds: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let failedActivationRpc = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/rest/v1/", "");
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });

    if (path === "cf_cashfree_webhook_events") {
      if (method === "GET") {
        const eventId = url.searchParams.get("event_id")?.replace(/^eq\./, "");
        return Response.json(events.filter(event => event["event_id"] === eventId));
      }
      if (method === "POST" && body) {
        events.push(body);
        return new Response(null, { status: 201 });
      }
    }

    if (path === "cf_payment_orders") {
      if (method === "GET") return Response.json([order]);
      if (method === "PATCH" && body) {
        const statusFilter = url.searchParams.get("status")?.replace(/^eq\./, "");
        if (!statusFilter || order["status"] === statusFilter) {
          order = { ...order, ...body };
        }
        return new Response(null, { status: 204 });
      }
    }

    if (path === "rpc/cf_record_cashfree_refund" && method === "POST" && body) {
      const refundId = String(body["p_refund_id"] || "");
      const requestedOrderId = String(body["p_order_id"] || "");
      const requestedPaymentId = String(body["p_payment_id"] || "");
      const amount = Number(body["p_refund_amount_paise"]);
      const currency = String(body["p_refund_currency"] || "");
      const isAutoRefund = body["p_is_auto_refund"] === true;
      if (requestedOrderId !== String(order["cashfree_order_id"]) ||
          currency !== String(order["currency"]) ||
          !Number.isSafeInteger(amount) || amount <= 0 ||
          amount > Number(order["amount_paise"])) {
        return Response.json({ error: "invalid refund" }, { status: 400 });
      }
      const existing = refunds.find(refund => refund["cf_refund_id"] === refundId);
      if (existing) {
        if (existing["order_id"] !== requestedOrderId ||
            existing["cf_payment_id"] !== requestedPaymentId ||
            existing["refund_amount_paise"] !== amount ||
            existing["refund_currency"] !== currency) {
          return Response.json({ error: "idempotency conflict" }, { status: 400 });
        }
      } else {
        refunds.push({
          cf_refund_id: refundId,
          order_id: requestedOrderId,
          cf_payment_id: requestedPaymentId,
          refund_amount_paise: amount,
          refund_currency: currency,
        });
      }
      const total = refunds
        .filter(refund => refund["order_id"] === requestedOrderId &&
          refund["cf_payment_id"] === requestedPaymentId &&
          refund["refund_currency"] === currency)
        .reduce((sum, refund) => sum + Number(refund["refund_amount_paise"]), 0);
      if (total > Number(order["amount_paise"])) {
        return Response.json({ error: "refund total exceeds order" }, { status: 400 });
      }
      let revoked = false;
      if (total === Number(order["amount_paise"])) {
        if (order["cashfree_payment_id"] != null &&
            requestedPaymentId === String(order["cashfree_payment_id"])) {
          if (order["status"] === "paid") order = { ...order, status: "refunded" };
          for (let index = 0; index < subscriptions.length; index += 1) {
            const row = subscriptions[index]!;
            if (row["cashfree_order_id"] === requestedOrderId &&
                row["cashfree_payment_id"] === requestedPaymentId &&
                row["status"] === "active") {
              subscriptions[index] = { ...row, status: "cancelled" };
              revoked = true;
            }
          }
        } else if (order["cashfree_payment_id"] == null && !isAutoRefund &&
            ["created", "failed", "paid"].includes(String(order["status"]))) {
          order = { ...order, status: "refunded", cashfree_payment_id: requestedPaymentId };
        }
      }
      return Response.json({
        ok: true,
        total_refunded_paise: total,
        fully_refunded: total === Number(order["amount_paise"]),
        revoked,
      });
    }

    if (path === "rpc/cf_activate_cashfree_subscription" && method === "POST" && body) {
      if (options.failFirstActivationRpc && !failedActivationRpc) {
        failedActivationRpc = true;
        return Response.json({ message: "temporary database failure" }, { status: 500 });
      }
      const requestedPaymentId = String(body["p_payment_id"] || "");
      if (order["status"] === "refunded") {
        return Response.json({ ok: false, error: "PAYMENT_ALREADY_REFUNDED" });
      }
      if (!["created", "failed", "paid"].includes(String(order["status"]))) {
        return Response.json({ ok: false, error: "PAYMENT_ORDER_NOT_ACTIVATABLE" });
      }
      if (order["cashfree_payment_id"] != null &&
          String(order["cashfree_payment_id"]) !== requestedPaymentId) {
        return Response.json({ ok: false, error: "BILLING_ORDER_PAYMENT_MISMATCH" });
      }
      const total = refunds
        .filter(refund => refund["order_id"] === orderId &&
          refund["cf_payment_id"] === requestedPaymentId &&
          refund["refund_currency"] === order["currency"])
        .reduce((sum, refund) => sum + Number(refund["refund_amount_paise"]), 0);
      if (total >= Number(order["amount_paise"])) {
        order = { ...order, status: "refunded", cashfree_payment_id: requestedPaymentId };
        return Response.json({ ok: false, error: "PAYMENT_ALREADY_REFUNDED" });
      }
      order = { ...order, status: "paid", cashfree_payment_id: requestedPaymentId };
      const existing = subscriptions.find(row => row["cashfree_order_id"] === orderId);
      if (existing) {
        if (existing["cashfree_payment_id"] != null &&
            String(existing["cashfree_payment_id"]) !== requestedPaymentId) {
          return Response.json({ ok: false, error: "BILLING_SUBSCRIPTION_PAYMENT_MISMATCH" });
        }
        if (existing["cashfree_payment_id"] == null) existing["cashfree_payment_id"] = requestedPaymentId;
        return Response.json({ ok: true, reused: true, status: existing["status"] });
      }
      subscriptions.push({
        id: "subscription_123",
        user_id: order["user_id"],
        plan_code: order["plan_code"],
        status: "active",
        starts_at: body["p_starts_at"],
        expires_at: body["p_expires_at"],
        cashfree_order_id: orderId,
        cashfree_payment_id: requestedPaymentId,
      });
      return Response.json({ ok: true, reused: false, status: "active" });
    }

    if (path === "cf_subscriptions") {
      if (method === "GET") {
        const cashfreeFilter = url.searchParams.get("cashfree_order_id");
        if (cashfreeFilter) {
          const requestedOrderId = cashfreeFilter.replace(/^eq\./, "");
          return Response.json(subscriptions.filter(row => row["cashfree_order_id"] === requestedOrderId));
        }
        const userFilter = url.searchParams.get("user_id");
        if (userFilter) {
          const requestedUserId = userFilter.replace(/^eq\./, "");
          return Response.json(subscriptions.filter(row =>
            row["user_id"] === requestedUserId && row["status"] === "active"
          ));
        }
        return Response.json(subscriptions);
      }
      if (method === "PATCH" && body) {
        for (let index = 0; index < subscriptions.length; index += 1) {
          const row = subscriptions[index]!;
          const orderFilter = url.searchParams.get("cashfree_order_id")?.replace(/^eq\./, "");
          const paymentFilter = url.searchParams.get("cashfree_payment_id")?.replace(/^eq\./, "");
          const statusFilter = url.searchParams.get("status")?.replace(/^eq\./, "");
          if ((!orderFilter || row["cashfree_order_id"] === orderFilter) &&
              (!paymentFilter || row["cashfree_payment_id"] === paymentFilter) &&
              (!statusFilter || row["status"] === statusFilter)) {
            subscriptions[index] = { ...row, ...body };
          }
        }
        return new Response(null, { status: 204 });
      }
    }

    return Response.json({ error: "Unexpected database request", method, path }, { status: 500 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    calls,
    subscriptions,
    refunds,
    events,
    get order() { return order; },
  };
}
function refundWebhookRequest(options: {
  amount?: number;
  paymentId?: string;
  refundId?: string;
  refundStatus?: "PENDING" | "SUCCESS" | "FAILED";
  includeIdempotencyHeader?: boolean;
  type?: "REFUND_STATUS_WEBHOOK" | "AUTO_REFUND_STATUS_WEBHOOK";
} = {}) {
  const eventType = options.type ?? "REFUND_STATUS_WEBHOOK";
  const refund = {
    cf_refund_id: options.refundId ?? "refund_123",
    cf_payment_id: options.paymentId ?? paymentId,
    refund_id: "merchant_refund_123",
    order_id: orderId,
    refund_amount: options.amount ?? 499,
    refund_currency: "INR",
    refund_status: options.refundStatus ?? "SUCCESS",
  };
  const event = {
    type: eventType,
    data: eventType === "AUTO_REFUND_STATUS_WEBHOOK"
      ? { auto_refund: refund }
      : { refund },
  };
  const headers = new Headers({
    "content-type": "application/json",
    "x-webhook-signature": "AQID",
    "x-webhook-timestamp": "1730000000",
  });
  if (options.includeIdempotencyHeader !== false) {
    headers.set("x-idempotency-key", "cashfree-refund-event-" + refund.cf_refund_id);
  }
  return new Request("https://codeforge.example/api/billing/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  });
}

function stubWebhookCrypto() {
  const importKey = vi.fn(async () => ({}));
  const sign = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
  vi.stubGlobal("crypto", { subtle: { importKey, sign } });
  return { importKey, sign };
}

function webhookRequest() {
  const event = {
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: {
      payment: {
        payment_status: "SUCCESS",
        payment_amount: 499,
        payment_currency: "INR",
        order_id: orderId,
        cf_payment_id: paymentId,
      },
      order: {
        order_id: orderId,
        order_currency: "INR",
      },
    },
  };
  return new Request("https://codeforge.example/api/billing/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": "AQID",
      "x-webhook-timestamp": "1730000000",
      "x-webhook-id": "event_recovery_123",
    },
    body: JSON.stringify(event),
  });
}

afterEach(() => {
  authMocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cashfree subscription activation recovery", () => {
  it("uses Cashfree's modern x-idempotency-key header for payment webhook deduplication", async () => {
    stubWebhookCrypto();
    const database = installDatabase();
    const request = new Request("https://codeforge.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "AQID",
        "x-webhook-timestamp": "1730000000",
        "x-idempotency-key": "modern-cashfree-event-key",
      },
      body: JSON.stringify({
        type: "PAYMENT_SUCCESS_WEBHOOK",
        data: {
          order: { order_id: orderId, order_currency: "INR" },
          payment: {
            payment_status: "SUCCESS",
            payment_amount: 499,
            payment_currency: "INR",
            cf_payment_id: paymentId,
          },
        },
      }),
    });

    const response = await handleBillingApiRequest(request, runtimeEnv);

    expect(response?.status).toBe(200);
    expect(database.events).toContainEqual({
      event_id: "modern-cashfree-event-key",
      event_type: "PAYMENT_SUCCESS_WEBHOOK",
    });
  });

  it("revokes the active subscription after successful full refund webhooks", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialSubscription: true });

    const response = await handleBillingApiRequest(refundWebhookRequest(), runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(database.refunds).toHaveLength(1);
    expect(database.order).toMatchObject({ status: "refunded" });
    expect(database.subscriptions[0]).toMatchObject({ status: "cancelled" });
    expect(database.events).toContainEqual({
      event_id: "cashfree-refund-event-refund_123:SUCCESS",
      event_type: "REFUND_STATUS_WEBHOOK",
    });
  });

  it("processes a refund that moves from PENDING to SUCCESS when no delivery key is present", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialSubscription: true });

    const pending = await handleBillingApiRequest(refundWebhookRequest({
      refundStatus: "PENDING",
    }), runtimeEnv);
    expect(pending?.status).toBe(200);
    expect(database.refunds).toHaveLength(0);
    expect(database.order).toMatchObject({ status: "paid" });
    expect(database.subscriptions[0]).toMatchObject({ status: "active" });

    const success = await handleBillingApiRequest(refundWebhookRequest({
      refundStatus: "SUCCESS",
    }), runtimeEnv);
    expect(success?.status).toBe(200);
    expect(database.refunds).toHaveLength(1);
    expect(database.order).toMatchObject({ status: "refunded" });
    expect(database.subscriptions[0]).toMatchObject({ status: "cancelled" });
    expect(database.events.map(event => event["event_id"])).toContain(
      "cashfree-refund-event-refund_123:PENDING",
    );
    expect(database.events.map(event => event["event_id"])).toContain(
      "cashfree-refund-event-refund_123:SUCCESS",
    );
  });

  it("does not revoke a plan after a partial refund", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialSubscription: true });

    const response = await handleBillingApiRequest(
      refundWebhookRequest({ amount: 100 }),
      runtimeEnv,
    );

    expect(response?.status).toBe(200);
    expect(database.refunds).toHaveLength(1);
    expect(database.order).toMatchObject({ status: "paid" });
    expect(database.subscriptions[0]).toMatchObject({ status: "active" });
  });

  it("revokes access when separate partial refunds cumulatively reach the paid amount", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialSubscription: true });

    const first = await handleBillingApiRequest(
      refundWebhookRequest({ amount: 249.5, refundId: "partial_refund_a" }),
      runtimeEnv,
    );
    expect(first?.status).toBe(200);
    expect(database.order).toMatchObject({ status: "paid" });
    expect(database.subscriptions[0]).toMatchObject({ status: "active" });

    const secondRequest = refundWebhookRequest({ amount: 249.5, refundId: "partial_refund_b" });
    const second = await handleBillingApiRequest(secondRequest, runtimeEnv);
    expect(second?.status).toBe(200);
    expect(database.refunds).toHaveLength(2);
    expect(database.order).toMatchObject({ status: "refunded" });
    expect(database.subscriptions[0]).toMatchObject({ status: "cancelled" });

    const duplicate = await handleBillingApiRequest(
      refundWebhookRequest({ amount: 249.5, refundId: "partial_refund_b" }),
      runtimeEnv,
    );
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ ok: true, duplicate: true });
    expect(database.refunds).toHaveLength(2);
  });

  it("records automatic refunds for a duplicate payment attempt without revoking the paid subscription", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialSubscription: true });

    const response = await handleBillingApiRequest(
      refundWebhookRequest({
        amount: 499,
        paymentId: "duplicate-payment-attempt",
        refundId: "auto_refund_456",
        type: "AUTO_REFUND_STATUS_WEBHOOK",
      }),
      runtimeEnv,
    );

    expect(response?.status).toBe(200);
    expect(database.refunds).toHaveLength(1);
    expect(database.order).toMatchObject({ status: "paid" });
    expect(database.subscriptions[0]).toMatchObject({ status: "active" });
  });



  it("rejects oversized webhook bodies before signature verification or database access", async () => {
    const cryptoMocks = stubWebhookCrypto();
    const database = installDatabase();
    const request = new Request("https://codeforge.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "AQID",
        "x-webhook-timestamp": "1730000000",
      },
      body: " ".repeat(256 * 1024 + 1),
    });

    const response = await handleBillingApiRequest(request, runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(413);
    expect(payload.error).toBe("WEBHOOK_BODY_TOO_LARGE");
    expect(cryptoMocks.importKey).not.toHaveBeenCalled();
    expect(database.fetchMock).not.toHaveBeenCalled();
  });
  it("does not let a late payment-failed webhook downgrade an activated subscription", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialOrderStatus: "created", initialPaymentId: null });

    const success = await handleBillingApiRequest(webhookRequest(), runtimeEnv);
    expect(success?.status).toBe(200);
    expect(database.order).toMatchObject({ status: "paid", cashfree_payment_id: paymentId });
    expect(database.subscriptions).toHaveLength(1);

    const lateFailure = new Request("https://codeforge.example/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "AQID",
        "x-webhook-timestamp": "1730000000",
        "x-webhook-id": "late-payment-failed-event",
      },
      body: JSON.stringify({
        type: "PAYMENT_FAILED_WEBHOOK",
        data: {
          payment: { order_id: orderId, cf_payment_id: paymentId },
          order: { order_id: orderId, order_currency: "INR" },
        },
      }),
    });
    const failed = await handleBillingApiRequest(lateFailure, runtimeEnv);

    expect(failed?.status).toBe(200);
    expect(database.order).toMatchObject({ status: "paid", cashfree_payment_id: paymentId });
    expect(database.subscriptions).toHaveLength(1);
    expect(database.subscriptions[0]).toMatchObject({ status: "active", cashfree_payment_id: paymentId });
    expect(database.events).toHaveLength(2);
  });

  it("does not activate a subscription when a full refund webhook arrives before payment success", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialOrderStatus: "created", initialPaymentId: null });

    const refund = await handleBillingApiRequest(refundWebhookRequest(), runtimeEnv);
    expect(refund?.status).toBe(200);
    expect(database.order).toMatchObject({ status: "refunded", cashfree_payment_id: paymentId });

    const payment = await handleBillingApiRequest(webhookRequest(), runtimeEnv);
    const payload = await payment?.json();

    expect(payment?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, refunded: true });
    expect(database.order).toMatchObject({ status: "refunded" });
    expect(database.subscriptions).toHaveLength(0);
    expect(database.events).toHaveLength(2);
  });

  it("still activates after a partial refund that arrived before payment success", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialOrderStatus: "created", initialPaymentId: null });

    const refund = await handleBillingApiRequest(refundWebhookRequest({ amount: 100 }), runtimeEnv);
    expect(refund?.status).toBe(200);
    expect(database.order).toMatchObject({ status: "created", cashfree_payment_id: null });

    const payment = await handleBillingApiRequest(webhookRequest(), runtimeEnv);
    expect(payment?.status).toBe(200);
    expect(await payment?.json()).toMatchObject({ ok: true });
    expect(database.order).toMatchObject({ status: "paid", cashfree_payment_id: paymentId });
    expect(database.subscriptions).toHaveLength(1);
    expect(database.subscriptions[0]).toMatchObject({ status: "active", cashfree_payment_id: paymentId });
  });

  it("does not block the original payment when an auto-refund for another attempt arrives first", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ initialOrderStatus: "created", initialPaymentId: null });

    const refund = await handleBillingApiRequest(refundWebhookRequest({
      paymentId: "duplicate-payment-attempt",
      refundId: "auto_refund_before_payment",
      type: "AUTO_REFUND_STATUS_WEBHOOK",
    }), runtimeEnv);
    expect(refund?.status).toBe(200);
    expect(database.order).toMatchObject({ status: "created", cashfree_payment_id: null });

    const payment = await handleBillingApiRequest(webhookRequest(), runtimeEnv);
    expect(payment?.status).toBe(200);
    expect(await payment?.json()).toMatchObject({ ok: true });
    expect(database.order).toMatchObject({ status: "paid", cashfree_payment_id: paymentId });
    expect(database.subscriptions).toHaveLength(1);
    expect(database.subscriptions[0]).toMatchObject({ status: "active", cashfree_payment_id: paymentId });
  });

  it("retries atomic activation after a transient database failure", async () => {
    stubWebhookCrypto();
    const database = installDatabase({ failFirstActivationRpc: true });

    await expect(handleBillingApiRequest(webhookRequest(), runtimeEnv))
      .rejects.toThrow("BILLING_SUBSCRIPTION_ACTIVATION_FAILED");

    expect(database.order).toMatchObject({
      status: "paid",
      cashfree_payment_id: paymentId,
    });
    expect(database.subscriptions).toHaveLength(0);
    expect(database.events).toHaveLength(0);

    const retry = await handleBillingApiRequest(webhookRequest(), runtimeEnv);
    const payload = await retry?.json();

    expect(retry?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true });
    expect(database.subscriptions).toHaveLength(1);
    expect(database.subscriptions[0]).toMatchObject({
      user_id: userId,
      plan_code: "pro_monthly",
      status: "active",
      cashfree_order_id: orderId,
      cashfree_payment_id: paymentId,
    });
    expect(database.events).toHaveLength(1);
  });

  it("returns an explicit refunded result when the owner retries payment verification", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId, email: "user@example.com", displayName: "User", avatarUrl: "" },
      cookies: [],
    });
    const database = installDatabase({ initialOrderStatus: "refunded" });

    const response = await handleBillingApiRequest(
      new Request("https://codeforge.example/api/billing/verify-payment", {
        method: "POST",
        headers: { origin: "https://codeforge.example", "content-type": "application/json" },
        body: JSON.stringify({ orderId }),
      }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(409);
    expect(payload).toMatchObject({ error: "PAYMENT_ALREADY_REFUNDED" });
    expect(database.calls.map(call => call.path)).toEqual(["cf_payment_orders"]);
    expect(database.subscriptions).toHaveLength(0);
  });

  it("repairs a paid order with a missing subscription when the owner retries payment verification", async () => {
    authMocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: userId, email: "user@example.com", displayName: "User", avatarUrl: "" },
      cookies: [],
    });
    const database = installDatabase();

    const request = new Request("https://codeforge.example/api/billing/verify-payment", {
      method: "POST",
      headers: {
        origin: "https://codeforge.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ orderId }),
    });

    const response = await handleBillingApiRequest(request, runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, paid: true, planCode: "pro_monthly" });
    expect(database.subscriptions).toHaveLength(1);
    expect(database.subscriptions[0]).toMatchObject({
      user_id: userId,
      cashfree_order_id: orderId,
      cashfree_payment_id: paymentId,
      status: "active",
    });
  });
});
