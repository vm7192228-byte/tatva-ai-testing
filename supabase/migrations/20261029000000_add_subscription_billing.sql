-- CodeForge subscription and Razorpay payment records.
-- All three tables are server-only; clients must not read or write them directly.
create table if not exists public.cf_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null,
  status text not null default 'inactive' check (status in ('inactive','active','cancelled','expired','past_due')),
  starts_at timestamptz,
  expires_at timestamptz,
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cf_subscriptions_user_status_idx on public.cf_subscriptions(user_id, status, expires_at desc);

create table if not exists public.cf_payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null,
  razorpay_order_id text not null unique,
  razorpay_payment_id text unique,
  amount_paise integer not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  status text not null default 'created' check (status in ('created','paid','failed','refunded')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists cf_payment_orders_user_created_idx on public.cf_payment_orders(user_id, created_at desc);

create table if not exists public.cf_razorpay_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.cf_subscriptions enable row level security;
alter table public.cf_payment_orders enable row level security;
alter table public.cf_razorpay_webhook_events enable row level security;
revoke all on public.cf_subscriptions from anon, authenticated;
revoke all on public.cf_payment_orders from anon, authenticated;
revoke all on public.cf_razorpay_webhook_events from anon, authenticated;
grant all on public.cf_subscriptions to service_role;
grant all on public.cf_payment_orders to service_role;
grant all on public.cf_razorpay_webhook_events to service_role;
