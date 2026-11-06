-- Retry-safe Cashfree checkout attempts.
-- One account + idempotency key maps to one Cashfree order and one payment session.
alter table public.cf_payment_orders
  add column if not exists checkout_idempotency_key uuid,
  add column if not exists checkout_request_hash text,
  add column if not exists cashfree_payment_session_id text;

create unique index if not exists cf_payment_orders_user_checkout_idempotency_uidx
  on public.cf_payment_orders (user_id, checkout_idempotency_key)
  where checkout_idempotency_key is not null;

create index if not exists cf_payment_orders_user_pending_created_idx
  on public.cf_payment_orders (user_id, status, created_at desc);
