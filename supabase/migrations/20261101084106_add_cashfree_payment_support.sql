-- Extend CodeForge billing to support Cashfree without deleting legacy Razorpay history.
alter table public.cf_payment_orders
  alter column razorpay_order_id drop not null;

alter table public.cf_payment_orders
  add column if not exists cashfree_order_id text,
  add column if not exists cashfree_cf_order_id text,
  add column if not exists cashfree_payment_id text;

alter table public.cf_subscriptions
  add column if not exists cashfree_order_id text,
  add column if not exists cashfree_payment_id text;

create unique index if not exists cf_payment_orders_cashfree_order_id_uidx
  on public.cf_payment_orders (cashfree_order_id)
  where cashfree_order_id is not null;

create unique index if not exists cf_payment_orders_cashfree_payment_id_uidx
  on public.cf_payment_orders (cashfree_payment_id)
  where cashfree_payment_id is not null;

create unique index if not exists cf_subscriptions_cashfree_order_id_uidx
  on public.cf_subscriptions (cashfree_order_id)
  where cashfree_order_id is not null;

create unique index if not exists cf_subscriptions_cashfree_payment_id_uidx
  on public.cf_subscriptions (cashfree_payment_id)
  where cashfree_payment_id is not null;

create table if not exists public.cf_cashfree_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.cf_cashfree_webhook_events enable row level security;
revoke all on public.cf_cashfree_webhook_events from anon, authenticated;
grant all on public.cf_cashfree_webhook_events to service_role;
