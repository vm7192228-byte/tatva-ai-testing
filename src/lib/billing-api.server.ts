import { createHash } from "node:crypto";
import { getAuthenticatedSession } from "./auth-api.server";

type RuntimeEnv = Record<string, unknown>;
type PlanCode = "starter_monthly" | "pro_monthly" | "pro_yearly" | "creator_monthly";
type PaymentOrder = {
  cashfree_order_id: string;
  plan_code: PlanCode;
  status: string;
  user_id: string;
  amount_paise: number;
  currency: string;
  cashfree_payment_id?: string | null;
  cashfree_payment_session_id?: string | null;
  checkout_request_hash?: string | null;
};
type ConfirmedCashfreePayment = Record<string, unknown> & {
  cf_payment_id: string | number;
};

const MAX_CASHFREE_WEBHOOK_BYTES = 256 * 1024;

type BoundedWebhookBody =
  | { ok: true; raw: string }
  | { ok: false; reason: "too_large" | "invalid_body" };

async function readBoundedWebhookBody(request: Request): Promise<BoundedWebhookBody> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_CASHFREE_WEBHOOK_BYTES) {
      try { await request.body?.cancel(); } catch { /* Reject without buffering the oversized body. */ }
      return { ok: false, reason: "too_large" };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, raw: "" };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_CASHFREE_WEBHOOK_BYTES) {
        try { await reader.cancel(); } catch { /* Stop reading an oversized webhook. */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    try { await reader.cancel(); } catch { /* The request stream already failed. */ }
    return { ok: false, reason: "invalid_body" };
  } finally {
    try { reader.releaseLock(); } catch { /* The stream may already be cancelled. */ }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function asPaymentOrder(value: unknown): PaymentOrder | null {
  if (!isRecord(value) || !planValid(value["plan_code"]) ||
      typeof value["cashfree_order_id"] !== "string" ||
      typeof value["status"] !== "string" ||
      typeof value["user_id"] !== "string" ||
      typeof value["currency"] !== "string" ||
      !Number.isSafeInteger(Number(value["amount_paise"]))) return null;
  return {
    cashfree_order_id: value["cashfree_order_id"],
    plan_code: value["plan_code"],
    status: value["status"],
    user_id: value["user_id"],
    amount_paise: Number(value["amount_paise"]),
    currency: value["currency"],
    cashfree_payment_id: typeof value["cashfree_payment_id"] === "string"
      ? value["cashfree_payment_id"]
      : null,
  };
}

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object" ? (runtimeEnv as RuntimeEnv)[name] : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra,
  }});
}
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  // Browser checkout and verification POSTs without Origin are accepted only
  // when Fetch Metadata explicitly marks them as same-origin.
  return request.headers.get("sec-fetch-site") === "same-origin";
}
function dbConfig(runtimeEnv: unknown) {
  const url = envValue("SUPABASE_URL", runtimeEnv);
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY", runtimeEnv) ?? envValue("SUPABASE_SECRET_KEY", runtimeEnv);
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}
async function dbRequest(runtimeEnv: unknown, path: string, init: RequestInit = {}) {
  const cfg = dbConfig(runtimeEnv);
  if (!cfg) throw new Error("BILLING_DATABASE_NOT_CONFIGURED");
  const headers = new Headers(init.headers);
  headers.set("apikey", cfg.key); headers.set("authorization", "Bearer " + cfg.key);
  headers.set("content-type", "application/json");
  return fetch(cfg.url + "/rest/v1/" + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(12_000) });
}
async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

async function readMonthlyFeatureUsage(
  runtimeEnv: unknown,
  userId: string,
  planCode: string,
  featureCode: string,
  monthStart: string,
  nextMonthStart: string,
  nowIso: string,
): Promise<{ used: number; reserved: number; limit: number; remaining: number; mode: string; unit: string }> {
  const dateFilter = "&and=" + encodeURIComponent("(created_at.gte." + monthStart + ",created_at.lt." + nextMonthStart + ")");
  const [planResponse, usageResponse, reservationResponse] = await Promise.all([
    dbRequest(runtimeEnv,
      "cf_plan_limits?select=monthly_limit&plan_code=eq." + encodeURIComponent(planCode) +
      "&feature_code=eq." + encodeURIComponent(featureCode) + "&limit=1"
    ),
    dbRequest(runtimeEnv,
      "cf_usage_events?select=id&user_id=eq." + encodeURIComponent(userId) +
      "&feature_code=eq." + encodeURIComponent(featureCode) + dateFilter,
      { headers: { prefer: "count=exact", range: "0-0" } }
    ),
    dbRequest(runtimeEnv,
      "cf_usage_reservations?select=id&user_id=eq." + encodeURIComponent(userId) +
      "&feature_code=eq." + encodeURIComponent(featureCode) +
      "&status=eq.reserved&expires_at=gt." + encodeURIComponent(nowIso) + dateFilter,
      { headers: { prefer: "count=exact", range: "0-0" } }
    ),
  ]);
  if (!planResponse.ok) throw new Error("FEATURE_PLAN_LIMIT_LOOKUP_FAILED");
  if (!usageResponse.ok) throw new Error("FEATURE_USAGE_LOOKUP_FAILED");
  if (!reservationResponse.ok) throw new Error("FEATURE_RESERVATION_LOOKUP_FAILED");
  const planRows = asRecordArray(await readJson(planResponse));
  if (!planRows.length) throw new Error("FEATURE_PLAN_LIMIT_MISSING");
  const limit = Number(planRows[0]?.["monthly_limit"]);
  if (!Number.isSafeInteger(limit) || limit < -1) throw new Error("FEATURE_PLAN_LIMIT_INVALID");
  const usageRange = usageResponse.headers.get("content-range") || "";
  const usageTotal = usageRange.match(/\/(\d+)$/);
  const reservationRange = reservationResponse.headers.get("content-range") || "";
  const reservationTotal = reservationRange.match(/\/(\d+)$/);
  if (!usageTotal || !reservationTotal) throw new Error("FEATURE_USAGE_COUNT_UNAVAILABLE");
  const used = Number(usageTotal[1]);
  const reserved = Number(reservationTotal[1]);
  if (!Number.isSafeInteger(used) || used < 0 ||
      !Number.isSafeInteger(reserved) || reserved < 0) {
    throw new Error("FEATURE_USAGE_COUNT_INVALID");
  }
  const total = used + reserved;
  return {
    used,
    reserved,
    limit,
    remaining: limit === -1 ? -1 : Math.max(limit - total, 0),
    mode: limit === -1 ? "unlimited-plan" : "monthly-plan-allowance",
    unit: featureCode === "image_generation" ? "image"
      : featureCode === "file_analysis" ? "file"
        : featureCode === "social_analysis" ? "analysis"
          : "action",
  };
}

async function readVideoQuotaStatus(runtimeEnv: unknown, userId: string): Promise<{
  used: number; limit: number; remaining: number; planCode: string; mode: string; unit: string;
}> {
  const response = await dbRequest(runtimeEnv, "rpc/cf_video_quota_status", {
    method: "POST",
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!response.ok) throw new Error("VIDEO_USAGE_LOOKUP_FAILED");
  const payload: unknown = await readJson(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VIDEO_USAGE_INVALID_RESPONSE");
  }
  const record = payload as Record<string, unknown>;
  const used = record["used"];
  const limit = record["limit"];
  const remaining = record["remaining"];
  const planCode = record["planCode"];
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(limit) ||
      !Number.isSafeInteger(remaining) || typeof planCode !== "string" ||
      (used as number) < 0 || (limit as number) < 0 || (remaining as number) < 0) {
    throw new Error("VIDEO_USAGE_INVALID_RESPONSE");
  }
  return {
    used: used as number,
    limit: limit as number,
    remaining: remaining as number,
    planCode,
    mode: (limit as number) === 0 ? "not-included" : "monthly-plan-allowance",
    unit: "credit",
  };
}
function cashfreeConfig(runtimeEnv: unknown) {
  const clientId = envValue("CASHFREE_APP_ID", runtimeEnv);
  const clientSecret = envValue("CASHFREE_SECRET_KEY", runtimeEnv);
  const requestedMode = envValue("CASHFREE_ENVIRONMENT", runtimeEnv)?.toLowerCase();
  const mode = requestedMode === "production" ? "production" : "sandbox";
  if (!clientId || !clientSecret) return null;
  if (mode === "production" && clientId.startsWith("TEST")) return null;
  return {
    clientId,
    clientSecret,
    mode,
    baseUrl: mode === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg",
  };
}
async function cashfreeRequest(runtimeEnv: unknown, path: string, init: RequestInit = {}) {
  const config = cashfreeConfig(runtimeEnv);
  if (!config) throw new Error("CASHFREE_NOT_CONFIGURED");
  const headers = new Headers(init.headers);
  headers.set("x-client-id", config.clientId);
  headers.set("x-client-secret", config.clientSecret);
  headers.set("x-api-version", "2025-01-01");
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return fetch(config.baseUrl + path, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}
async function hmacBase64(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function amountFor(plan: PlanCode, runtimeEnv: unknown) {
  const key = plan === "starter_monthly" ? "RAZORPAY_PLAN_STARTER_AMOUNT_PAISE" : plan === "pro_monthly" ? "RAZORPAY_PLAN_PRO_MONTHLY_AMOUNT_PAISE" : plan === "creator_monthly" ? "RAZORPAY_PLAN_CREATOR_MONTHLY_AMOUNT_PAISE" : "RAZORPAY_PLAN_PRO_YEARLY_AMOUNT_PAISE";
  const raw = envValue(key, runtimeEnv);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) && amount >= 100 ? amount : null;
}
function planValid(value: unknown): value is PlanCode { return value === "starter_monthly" || value === "pro_monthly" || value === "pro_yearly" || value === "creator_monthly"; }
/** Only current public paid plans may start new checkouts. Legacy codes remain valid for old order recovery. */
function checkoutPlanValid(value: unknown): value is "pro_monthly" | "creator_monthly" {
  return value === "pro_monthly" || value === "creator_monthly";
}
async function getEntitlement(runtimeEnv: unknown, userId: string) {
  const response = await dbRequest(runtimeEnv, "cf_subscriptions?select=plan_code,status,starts_at,expires_at&user_id=eq." + encodeURIComponent(userId) + "&status=eq.active&order=expires_at.desc&limit=1");
  if (!response.ok) throw new Error("BILLING_DATABASE_QUERY_FAILED");
  const row = asRecordArray(await readJson(response))[0] ?? null;
  const expiresAt = typeof row?.["expires_at"] === "string" ? row["expires_at"] : null;
  const startsAt = typeof row?.["starts_at"] === "string" ? row["starts_at"] : null;
  const planCode = typeof row?.["plan_code"] === "string" ? row["plan_code"] : null;
  const active = Boolean(row && (!expiresAt || Date.parse(expiresAt) > Date.now()) &&
    (!startsAt || Date.parse(startsAt) <= Date.now()) && planCode);
  return { paid: active, planCode: active ? planCode : null, expiresAt: active ? expiresAt : null };
}
async function updateOrder(runtimeEnv: unknown, orderId: string, fields: Record<string, unknown>) {
  const response = await dbRequest(runtimeEnv, "cf_payment_orders?cashfree_order_id=eq." + encodeURIComponent(orderId) + "&status=eq.created", {
    method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error("BILLING_ORDER_UPDATE_FAILED");
}
async function activateSubscription(
  runtimeEnv: unknown,
  order: PaymentOrder,
  paymentId: string,
): Promise<{ refunded: boolean }> {
  if (!paymentId || paymentId.length > 128) throw new Error("BILLING_PAYMENT_ID_INVALID");

  const now = new Date();
  const expiry = new Date(now);
  expiry.setUTCDate(expiry.getUTCDate() + (order.plan_code === "pro_yearly" ? 365 : 30));

  // This database transaction locks the order and checks the success-only refund
  // ledger before creating an entitlement. A refund event and payment success
  // can no longer win a race using stale application-level reads.
  const activation = await dbRequest(runtimeEnv, "rpc/cf_activate_cashfree_subscription", {
    method: "POST",
    body: JSON.stringify({
      p_order_id: order.cashfree_order_id,
      p_payment_id: paymentId,
      p_starts_at: now.toISOString(),
      p_expires_at: expiry.toISOString(),
    }),
  });
  if (!activation.ok) throw new Error("BILLING_SUBSCRIPTION_ACTIVATION_FAILED");
  const result = await readJson(activation);
  if (!isRecord(result)) throw new Error("BILLING_SUBSCRIPTION_ACTIVATION_INVALID");
  if (result["error"] === "PAYMENT_ALREADY_REFUNDED") return { refunded: true };
  if (result["ok"] !== true) {
    throw new Error(typeof result["error"] === "string"
      ? result["error"]
      : "BILLING_SUBSCRIPTION_ACTIVATION_FAILED");
  }
  return { refunded: false };
}
async function orderById(runtimeEnv: unknown, orderId: string): Promise<PaymentOrder | null> {
  const response = await dbRequest(runtimeEnv, "cf_payment_orders?select=*&cashfree_order_id=eq." + encodeURIComponent(orderId) + "&limit=1");
  if (!response.ok) throw new Error("BILLING_ORDER_LOOKUP_FAILED");
  const rows = asRecordArray(await readJson(response));
  return asPaymentOrder(rows[0]);
}

function amountToPaise(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const paise = Math.round(amount * 100);
  if (!Number.isSafeInteger(paise) || Math.abs(amount * 100 - paise) > 0.000001) return null;
  return paise;
}

async function recordSuccessfulCashfreeRefund(
  runtimeEnv: unknown,
  order: PaymentOrder,
  refund: Record<string, unknown>,
  paymentId: string,
  isAutoRefund: boolean,
): Promise<void> {
  const rawRefundId = refund["cf_refund_id"];
  const refundId = rawRefundId === undefined || rawRefundId === null ? "" : String(rawRefundId).trim();
  const refundAmountPaise = amountToPaise(refund["refund_amount"]);
  const refundCurrency = String(refund["refund_currency"] || order.currency).trim().toUpperCase();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(refundId) ||
      !paymentId || paymentId.length > 128 ||
      !refundAmountPaise || refundAmountPaise > order.amount_paise ||
      refundCurrency !== order.currency) {
    throw new Error("CASHFREE_REFUND_DETAILS_INVALID");
  }

  // A database RPC serializes refund updates on the payment-order row and
  // atomically inserts the refund, reconciles the cumulative total, and revokes
  // access only after the original activating payment is fully refunded.
  const reconciliation = await dbRequest(runtimeEnv, "rpc/cf_record_cashfree_refund", {
    method: "POST",
    body: JSON.stringify({
      p_refund_id: refundId,
      p_order_id: order.cashfree_order_id,
      p_payment_id: paymentId,
      p_refund_amount_paise: refundAmountPaise,
      p_refund_currency: refundCurrency,
      p_is_auto_refund: isAutoRefund,
    }),
  });
  if (!reconciliation.ok) throw new Error("CASHFREE_REFUND_RECONCILIATION_FAILED");
  const result = await readJson(reconciliation);
  const totalRefundedPaise = isRecord(result) ? Number(result["total_refunded_paise"]) : NaN;
  if (!isRecord(result) || result["ok"] !== true ||
      !Number.isSafeInteger(totalRefundedPaise) ||
      totalRefundedPaise < 0 || totalRefundedPaise > order.amount_paise) {
    throw new Error("CASHFREE_REFUND_RECONCILIATION_INVALID");
  }

}
async function confirmedCashfreePayment(
  runtimeEnv: unknown,
  order: PaymentOrder,
): Promise<ConfirmedCashfreePayment | null> {
  const response = await cashfreeRequest(runtimeEnv, "/orders/" + encodeURIComponent(order.cashfree_order_id) + "/payments", {
    method: "GET",
  });
  const payments = await readJson(response);
  if (!response.ok || !Array.isArray(payments)) throw new Error("CASHFREE_PAYMENT_LOOKUP_FAILED");
  const success = payments.find((value): value is ConfirmedCashfreePayment => {
    if (!isRecord(value)) return false;
    const paymentId = value["cf_payment_id"];
    return value["payment_status"] === "SUCCESS" &&
      Math.round(Number(value["payment_amount"]) * 100) === order.amount_paise &&
      value["payment_currency"] === order.currency &&
      String(value["order_id"]) === order.cashfree_order_id &&
      (typeof paymentId === "string" || typeof paymentId === "number");
  });
  return success ?? null;
}

export async function handleBillingApiRequest(request: Request, runtimeEnv: unknown): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/billing")) return null;

  if (url.pathname === "/api/billing/webhook") {
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "POST" });
    const config = cashfreeConfig(runtimeEnv);
    if (!config) return json({ error: "CASHFREE_NOT_CONFIGURED", message: "Add CASHFREE_APP_ID and CASHFREE_SECRET_KEY to the server environment." }, 503);

    const boundedBody = await readBoundedWebhookBody(request);
    if (!boundedBody.ok) return json({ error: boundedBody.reason === "too_large" ? "WEBHOOK_BODY_TOO_LARGE" : "INVALID_BODY" }, boundedBody.reason === "too_large" ? 413 : 400);
    const raw = boundedBody.raw;
    const signature = request.headers.get("x-webhook-signature") || "";
    const timestamp = request.headers.get("x-webhook-timestamp") || "";
    if (!signature || !timestamp) return json({ error: "MISSING_WEBHOOK_SIGNATURE" }, 401);
    const expected = await hmacBase64(config.clientSecret, timestamp + raw);
    if (!safeEqual(signature, expected)) return json({ error: "INVALID_WEBHOOK_SIGNATURE" }, 401);

    let parsedEvent: unknown;
    try { parsedEvent = JSON.parse(raw); } catch { return json({ error: "INVALID_JSON" }, 400); }
    if (!isRecord(parsedEvent)) return json({ error: "INVALID_JSON" }, 400);
    const event = parsedEvent;
    const eventType = typeof event["type"] === "string" ? event["type"] : "UNKNOWN";
    const eventData = isRecord(event["data"]) ? event["data"] : {};
    const payment = isRecord(eventData["payment"]) ? eventData["payment"] : {};
    const orderInfo = isRecord(eventData["order"]) ? eventData["order"] : {};
    const refundInfo = eventType === "REFUND_STATUS_WEBHOOK" && isRecord(eventData["refund"])
      ? eventData["refund"]
      : eventType === "AUTO_REFUND_STATUS_WEBHOOK" && isRecord(eventData["auto_refund"])
        ? eventData["auto_refund"]
        : null;
    const orderId = typeof orderInfo["order_id"] === "string"
      ? orderInfo["order_id"]
      : typeof payment["order_id"] === "string"
        ? payment["order_id"]
        : typeof refundInfo?.["order_id"] === "string" ? refundInfo["order_id"] : "";
    const paymentId = payment["cf_payment_id"] === undefined || payment["cf_payment_id"] === null
      ? refundInfo?.["cf_payment_id"] === undefined || refundInfo?.["cf_payment_id"] === null
        ? "" : String(refundInfo["cf_payment_id"])
      : String(payment["cf_payment_id"]);
    const refundId = refundInfo?.["cf_refund_id"] === undefined || refundInfo?.["cf_refund_id"] === null
      ? "" : String(refundInfo["cf_refund_id"]);
    const eventHeaderId = request.headers.get("x-idempotency-key") ||
      request.headers.get("x-webhook-id") || "";
    // Cashfree may emit a refund lifecycle event more than once for the same
    // refund ID (for example PENDING followed by SUCCESS). If no per-delivery
    // idempotency header is supplied, include the status in the fallback key so
    // a non-final event cannot suppress the later successful refund.
    const refundStatusForEvent = String(refundInfo?.["refund_status"] || "UNKNOWN").toUpperCase();
    const eventId = refundId
      ? (eventHeaderId || eventType + ":" + refundId) + ":" + refundStatusForEvent
      : eventHeaderId || (paymentId ? eventType + ":" + paymentId : "");
    if (!orderId) return json({ error: "WEBHOOK_ORDER_ID_MISSING" }, 400);

    if (eventId) {
      const lookup = await dbRequest(runtimeEnv, "cf_cashfree_webhook_events?select=event_id&event_id=eq." + encodeURIComponent(eventId) + "&limit=1");
      if (!lookup.ok) return json({ error: "WEBHOOK_STORAGE_FAILED" }, 500);
      const seenRows = asRecordArray(await readJson(lookup));
      if (seenRows.length) return json({ ok: true, duplicate: true });
    }

    const order = await orderById(runtimeEnv, orderId);
    if (!order) return json({ error: "ORDER_NOT_FOUND" }, 404);

    let paymentAlreadyRefunded = false;
    if (refundInfo && (
      eventType === "REFUND_STATUS_WEBHOOK" || eventType === "AUTO_REFUND_STATUS_WEBHOOK"
    )) {
      const refundStatus = String(refundInfo["refund_status"] || "").toUpperCase();
      if (refundStatus === "SUCCESS") {
        await recordSuccessfulCashfreeRefund(
          runtimeEnv, order, refundInfo, paymentId,
          eventType === "AUTO_REFUND_STATUS_WEBHOOK",
        );
      }
    } else if (eventType === "PAYMENT_SUCCESS_WEBHOOK" && payment["payment_status"] === "SUCCESS") {
      const paidAmount = Math.round(Number(payment["payment_amount"]) * 100);
      const currency = payment["payment_currency"] || orderInfo["order_currency"];
      if (!paymentId || paidAmount !== Number(order.amount_paise) || currency !== order.currency) {
        return json({ error: "PAYMENT_DETAILS_MISMATCH" }, 400);
      }
      paymentAlreadyRefunded = (await activateSubscription(runtimeEnv, order, paymentId)).refunded;
    } else if (
      eventType === "PAYMENT_FAILED_WEBHOOK" ||
      eventType === "PAYMENT_USER_DROPPED_WEBHOOK"
    ) {
      await updateOrder(runtimeEnv, orderId, { status: "failed" });
    }

    if (eventId) {
      const stored = await dbRequest(runtimeEnv, "cf_cashfree_webhook_events", {
        method: "POST",
        headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ event_id: eventId, event_type: eventType }),
      });
      if (!stored.ok) return json({ error: "WEBHOOK_STORAGE_FAILED" }, 500);
    }
    return json({ ok: true, ...(paymentAlreadyRefunded ? { refunded: true } : {}) });
  }

  if (request.method === "GET" && url.pathname === "/api/billing/usage") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503);
    if (!session.user) {
      return json({
        ok: true,
        authenticated: false,
        planCode: "free",
        video: { used: 0, limit: 1, remaining: 1, mode: "sign-in-required", unit: "credit" },
        photo: { used: 0, limit: 2, remaining: 2, mode: "sign-in-required", unit: "image" },
        fileAnalysis: { used: 0, limit: 3, remaining: 3, mode: "sign-in-required", unit: "file" },
        socialAnalysis: { used: 0, limit: 3, remaining: 3, mode: "sign-in-required", unit: "analysis" },
        socialEdit: { used: 0, limit: 1, remaining: 1, mode: "sign-in-required", unit: "action" },
        aiChat: { used: 0, limit: null, remaining: null, mode: "free-provider-usage", unit: "request" },
      });
    }
    try {
      const entitlement = await getEntitlement(runtimeEnv, session.user.id);
      const planCode = entitlement.paid ? String(entitlement.planCode || "free") : "free";
      const now = new Date();
      const nowIso = now.toISOString();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

      const [video, photoUsage, fileAnalysis, socialAnalysis, socialEdit] = await Promise.all([
        readVideoQuotaStatus(runtimeEnv, session.user.id),
        readMonthlyFeatureUsage(runtimeEnv, session.user.id, planCode, "image_generation", monthStart, nextMonthStart, nowIso),
        readMonthlyFeatureUsage(runtimeEnv, session.user.id, planCode, "file_analysis", monthStart, nextMonthStart, nowIso),
        readMonthlyFeatureUsage(runtimeEnv, session.user.id, planCode, "social_analysis", monthStart, nextMonthStart, nowIso),
        readMonthlyFeatureUsage(runtimeEnv, session.user.id, planCode, "social_edit", monthStart, nextMonthStart, nowIso),
      ]);
      const photo = { ...photoUsage, trackingAvailable: true };

      const chatPlanResponse = await dbRequest(runtimeEnv,
        "cf_plan_limits?select=monthly_limit&plan_code=eq." + encodeURIComponent(planCode) +
        "&feature_code=eq.super_chat&limit=1"
      );
      if (!chatPlanResponse.ok) throw new Error("CHAT_PLAN_LIMIT_LOOKUP_FAILED");
      const chatPlanRows = asRecordArray(await readJson(chatPlanResponse));
      const hasChatPlanLimit = chatPlanRows.length > 0;
      let aiChat: { used: number; reserved: number; limit: number | null; remaining: number | null; mode: string; unit: string };
      if (!hasChatPlanLimit) {
        // Free routes use provider fair-use limits; the app has no monthly Super Chat cap for Free.
        aiChat = { used: 0, reserved: 0, limit: null, remaining: null, mode: "free-provider-usage", unit: "request" };
      } else {
        const chatLimit = Number(chatPlanRows[0]?.["monthly_limit"]);
        if (!Number.isInteger(chatLimit) || chatLimit < -1) throw new Error("CHAT_PLAN_LIMIT_INVALID");
          const chatDateFilter = "&and=" +
          encodeURIComponent("(created_at.gte." + monthStart + ",created_at.lt." + nextMonthStart + ")");
        const [chatResponse, chatReservationResponse] = await Promise.all([
          dbRequest(runtimeEnv,
            "cf_usage_events?select=id&user_id=eq." + encodeURIComponent(session.user.id) +
            "&feature_code=eq.super_chat" + chatDateFilter,
            { headers: { prefer: "count=exact", range: "0-0" } }
          ),
          dbRequest(runtimeEnv,
            "cf_usage_reservations?select=id&user_id=eq." + encodeURIComponent(session.user.id) +
            "&feature_code=eq.super_chat&status=eq.reserved&expires_at=gt." +
            encodeURIComponent(nowIso) + chatDateFilter,
            { headers: { prefer: "count=exact", range: "0-0" } }
          ),
        ]);
        if (!chatResponse.ok) throw new Error("CHAT_USAGE_LOOKUP_FAILED");
        if (!chatReservationResponse.ok) throw new Error("CHAT_RESERVATION_LOOKUP_FAILED");
        const usageRange = chatResponse.headers.get("content-range") || "";
        const usageTotal = usageRange.match(/\/(\d+)$/);
        const reservationRange = chatReservationResponse.headers.get("content-range") || "";
        const reservationTotal = reservationRange.match(/\/(\d+)$/);
        if (!usageTotal || !reservationTotal) throw new Error("CHAT_USAGE_COUNT_UNAVAILABLE");
        const chatUsed = Number(usageTotal[1]);
        const chatReserved = Number(reservationTotal[1]);
        if (!Number.isSafeInteger(chatUsed) || chatUsed < 0 ||
            !Number.isSafeInteger(chatReserved) || chatReserved < 0) {
          throw new Error("CHAT_USAGE_COUNT_INVALID");
        }
        aiChat = {
          used: chatUsed,
          reserved: chatReserved,
          limit: chatLimit,
          remaining: chatLimit === -1 ? -1 : Math.max(chatLimit - chatUsed - chatReserved, 0),
          mode: chatLimit === -1 ? "unlimited-plan" : "monthly-plan-allowance",
          unit: "request",
        };
      }

      return json({
        ok: true, authenticated: true, paid: entitlement.paid, planCode,
        video,
        photo,
        fileAnalysis,
        socialAnalysis,
        socialEdit,
        aiChat,
        expiresAt: entitlement.expiresAt || null,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 120) : "unknown";
      console.error("[Tatv billing] Monthly usage lookup failed:", reason);
      return json({ error: "USAGE_STATUS_UNAVAILABLE", message: "Your credit balance is temporarily unavailable." }, 503);
    }
  }

  if (request.method === "GET" && url.pathname === "/api/billing/status") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503);
    if (!session.user) return json({ ok: true, authenticated: false, paid: false });
    try { return json({ ok: true, authenticated: true, ...(await getEntitlement(runtimeEnv, session.user.id)) }); }
    catch { return json({ error: "BILLING_STATUS_UNAVAILABLE", message: "Subscription status is temporarily unavailable." }, 503); }
  }

  if (request.method !== "POST" || !sameOrigin(request)) return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  const session = await getAuthenticatedSession(request, runtimeEnv);
  if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503);
  if (!session.user) return json({ error: "SIGN_IN_REQUIRED", message: "Sign in before managing a subscription." }, 401);
  const config = cashfreeConfig(runtimeEnv);
  if (!config) return json({
    error: "CASHFREE_NOT_CONFIGURED",
    message: "Add the Cashfree TEST App ID and Secret Key in Vercel Environment Variables, then redeploy.",
  }, 503);

  if (url.pathname === "/api/billing/create-order") {
    let parsedBody: unknown;
    try { parsedBody = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
    if (!isRecord(parsedBody)) return json({ error: "INVALID_JSON" }, 400);
    const body = parsedBody;
    const planCode = body["planCode"];
    if (!checkoutPlanValid(planCode)) return json({ error: "INVALID_PLAN", message: "Choose one of the currently available subscription plans." }, 400);

    const phone = typeof body["phone"] === "string" ? body["phone"].replace(/\D/g, "") : "";
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return json({ error: "PHONE_REQUIRED", message: "Enter a valid 10-digit Indian mobile number to continue." }, 400);
    }

    const suppliedKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedKey)) {
      return json({ error: "IDEMPOTENCY_KEY_REQUIRED", message: "Refresh the checkout attempt and try again." }, 400);
    }

    const amount = amountFor(planCode, runtimeEnv);
    if (!amount) return json({ error: "PLAN_PRICE_NOT_CONFIGURED", message: "Subscription price has not been configured yet. Set the plan amount before accepting payments." }, 503);
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ userId: session.user.id, planCode, phone, amount, currency: "INR" }))
      .digest("hex");
    const orderId = "cf_" + createHash("sha256")
      .update(session.user.id + ":" + suppliedKey)
      .digest("hex")
      .slice(0, 36);

    try {
      const existing = await getEntitlement(runtimeEnv, session.user.id);
      if (existing.paid) return json({ error: "ALREADY_SUBSCRIBED", message: "Your subscription is already active.", ...existing }, 409);

      // Reserve the order locally before calling Cashfree. The unique
      // (user_id, checkout_idempotency_key) index serializes retries and gives
      // the same external order ID to every replay of this checkout attempt.
      let orderRow: Record<string, unknown> | null = null;
      const reserve = await dbRequest(runtimeEnv, "cf_payment_orders", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          user_id: session.user.id,
          plan_code: planCode,
          cashfree_order_id: orderId,
          cashfree_cf_order_id: null,
          cashfree_payment_session_id: null,
          checkout_idempotency_key: suppliedKey,
          checkout_request_hash: requestHash,
          amount_paise: amount,
          currency: "INR",
          status: "created",
        }),
      });
      if (reserve.ok) {
        orderRow = asRecordArray(await readJson(reserve))[0] ?? null;
        if (!orderRow) {
          const lookup = await dbRequest(
            runtimeEnv,
            "cf_payment_orders?select=cashfree_order_id,cashfree_payment_session_id,checkout_request_hash,status&user_id=eq." +
              encodeURIComponent(session.user.id) + "&checkout_idempotency_key=eq." +
              encodeURIComponent(suppliedKey) + "&limit=1",
          );
          if (!lookup.ok) return json({ error: "ORDER_STORAGE_FAILED", message: "Could not verify the reserved payment attempt." }, 503);
          orderRow = asRecordArray(await readJson(lookup))[0] ?? null;
        }
      } else if (reserve.status === 409) {
        const lookup = await dbRequest(
          runtimeEnv,
          "cf_payment_orders?select=cashfree_order_id,cashfree_payment_session_id,checkout_request_hash,status&user_id=eq." +
            encodeURIComponent(session.user.id) + "&checkout_idempotency_key=eq." +
            encodeURIComponent(suppliedKey) + "&limit=1",
        );
        if (!lookup.ok) return json({ error: "ORDER_STORAGE_FAILED", message: "Could not recover the existing payment attempt." }, 503);
        orderRow = asRecordArray(await readJson(lookup))[0] ?? null;
      } else {
        return json({ error: "ORDER_STORAGE_FAILED", message: "Could not reserve the payment attempt securely." }, 503);
      }

      if (!orderRow ||
          typeof orderRow["cashfree_order_id"] !== "string" ||
          typeof orderRow["checkout_request_hash"] !== "string") {
        return json({ error: "ORDER_STORAGE_FAILED", message: "The payment attempt could not be recovered securely." }, 503);
      }
      if (orderRow["checkout_request_hash"] !== requestHash) {
        return json({ error: "IDEMPOTENCY_KEY_REUSED", message: "This checkout key was already used for different plan or customer details. Start a new checkout attempt." }, 409);
      }
      if (orderRow["status"] !== "created") {
        return json({
          error: "CHECKOUT_ALREADY_PROCESSED",
          message: orderRow["status"] === "paid"
            ? "This checkout was already paid. Tatv is verifying the existing payment instead of creating another order."
            : "This payment attempt is no longer payable. Check its status before starting a new checkout.",
          orderId: orderRow["cashfree_order_id"],
          orderStatus: orderRow["status"],
        }, 409);
      }

      const storedSessionId = orderRow["cashfree_payment_session_id"];
      if (typeof storedSessionId === "string" && storedSessionId.length > 0) {
        return json({
          ok: true,
          orderId: orderRow["cashfree_order_id"],
          paymentSessionId: storedSessionId,
          amount,
          currency: "INR",
          planCode,
          mode: config.mode,
          reused: true,
        });
      }

      const origin = new URL(request.url).origin;
      const customerId = session.user.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
      const cashfreeResponse = await cashfreeRequest(runtimeEnv, "/orders", {
        method: "POST",
        headers: { "x-idempotency-key": suppliedKey },
        body: JSON.stringify({
          order_id: orderRow["cashfree_order_id"],
          order_amount: amount / 100,
          order_currency: "INR",
          customer_details: {
            customer_id: customerId,
            customer_name: session.user.displayName.slice(0, 100),
            customer_email: session.user.email,
            customer_phone: phone,
          },
          order_meta: {
            return_url: origin + "/?cashfree_return=1&order_id={order_id}",
          },
          order_note: ("Tatv " + planCode + " subscription").slice(0, 200),
        }),
      });
      const cashfreeOrder = await readJson(cashfreeResponse);
      if (!cashfreeResponse.ok || !isRecord(cashfreeOrder) ||
          cashfreeOrder["order_id"] !== orderRow["cashfree_order_id"] ||
          typeof cashfreeOrder["payment_session_id"] !== "string" ||
          !cashfreeOrder["payment_session_id"]) {
        console.error("[Tatv billing] Cashfree order creation failed:", cashfreeResponse.status);
        return json({
          error: "CASHFREE_ORDER_FAILED",
          message: "Cashfree could not confirm this checkout attempt. Retry this same checkout before starting another payment.",
        }, 502);
      }

      const saveSession = await dbRequest(
        runtimeEnv,
        "cf_payment_orders?cashfree_order_id=eq." + encodeURIComponent(String(orderRow["cashfree_order_id"])) +
          "&user_id=eq." + encodeURIComponent(session.user.id) +
          "&checkout_idempotency_key=eq." + encodeURIComponent(suppliedKey),
        {
          method: "PATCH",
          headers: { prefer: "return=minimal" },
          body: JSON.stringify({
            cashfree_cf_order_id: String(cashfreeOrder["cf_order_id"] ?? ""),
            cashfree_payment_session_id: cashfreeOrder["payment_session_id"],
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!saveSession.ok) {
        return json({ error: "ORDER_STORAGE_FAILED", message: "Cashfree prepared the order, but Tatv could not save its checkout session. Retry this same checkout to recover it safely." }, 503);
      }

      return json({
        ok: true,
        orderId: orderRow["cashfree_order_id"],
        paymentSessionId: cashfreeOrder["payment_session_id"],
        amount,
        currency: "INR",
        planCode,
        mode: config.mode,
        reused: false,
      });
    } catch (error) {
      return json({
        error: "BILLING_UNAVAILABLE",
        message: error instanceof Error && error.message === "BILLING_DATABASE_NOT_CONFIGURED"
          ? "Set SUPABASE_SERVICE_ROLE_KEY on the server."
          : error instanceof Error && error.message === "CASHFREE_NOT_CONFIGURED"
            ? "Configure Cashfree credentials for the selected sandbox or production mode."
            : "Subscription checkout is temporarily unavailable. Please retry the same checkout attempt.",
      }, 503);
    }
  }

  if (url.pathname === "/api/billing/verify-payment") {
    let parsedBody: unknown;
    try { parsedBody = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
    if (!isRecord(parsedBody)) return json({ error: "INVALID_JSON" }, 400);
    const orderId = typeof parsedBody["orderId"] === "string" ? parsedBody["orderId"].trim() : "";
    if (!orderId || orderId.length > 45) return json({ error: "INVALID_ORDER_ID" }, 400);

    try {
      const order = await orderById(runtimeEnv, orderId);
      if (!order || order.user_id !== session.user.id) return json({ error: "ORDER_NOT_FOUND" }, 404);

      if (order.status === "refunded") {
        return json({
          error: "PAYMENT_ALREADY_REFUNDED",
          message: "Cashfree confirmed that this payment was fully refunded. No subscription is active.",
        }, 409);
      }

      if (order.status === "paid") {
        let paymentId = typeof order.cashfree_payment_id === "string" ? order.cashfree_payment_id : "";
        if (!paymentId) {
          const recoveredPayment = await confirmedCashfreePayment(runtimeEnv, order);
          const recoveredId = recoveredPayment?.["cf_payment_id"];
          paymentId = recoveredId === undefined ? "" : String(recoveredId);
        }
        if (!paymentId) {
          return json({
            error: "PAYMENT_RECONCILIATION_PENDING",
            message: "Your payment is recorded, but subscription activation is still being reconciled. Please retry shortly.",
          }, 503);
        }
        const activation = await activateSubscription(runtimeEnv, order, paymentId);
        if (activation.refunded) {
          return json({
            error: "PAYMENT_ALREADY_REFUNDED",
            message: "Cashfree confirmed that this payment was fully refunded. No subscription was activated.",
          }, 409);
        }
        return json({ ok: true, ...(await getEntitlement(runtimeEnv, session.user.id)) });
      }
      if (order.status !== "created") return json({ error: "ORDER_NOT_PAYABLE" }, 409);

      const payment = await confirmedCashfreePayment(runtimeEnv, order);
      if (!payment) {
        return json({
          error: "PAYMENT_NOT_CONFIRMED",
          message: "Cashfree has not confirmed this payment yet. If you completed checkout, refresh the subscription status in a moment.",
        }, 409);
      }

      const activation = await activateSubscription(runtimeEnv, order, String(payment["cf_payment_id"]));
      if (activation.refunded) {
        return json({
          error: "PAYMENT_ALREADY_REFUNDED",
          message: "Cashfree confirmed that this payment was fully refunded. No subscription was activated.",
        }, 409);
      }
      return json({ ok: true, ...(await getEntitlement(runtimeEnv, session.user.id)) });
    } catch (error) {
      if (error instanceof Error && error.message === "PAYMENT_ALREADY_REFUNDED") {
        return json({
          error: "PAYMENT_ALREADY_REFUNDED",
          message: "Cashfree confirmed that this payment was fully refunded. No subscription is active.",
        }, 409);
      }
      return json({
        error: "PAYMENT_VERIFICATION_FAILED",
        message: error instanceof Error && error.message === "CASHFREE_NOT_CONFIGURED"
          ? "Add CASHFREE_APP_ID and CASHFREE_SECRET_KEY to the server environment."
          : "Could not verify and activate this payment. Please check your subscription status.",
      }, 503);
    }
  }
  return json({ error: "NOT_FOUND" }, 404);
}
