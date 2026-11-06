-- Minimal success-only refund ledger for Cashfree Payment Gateway.
-- A completed refund is recorded once per Cashfree refund ID. Partial refunds
-- are accumulated against the original payment; access is revoked only when
-- the successful refunded total reaches the amount paid for that payment.
create table if not exists public.cf_cashfree_refunds (
  cf_refund_id text primary key
    check (length(cf_refund_id) between 1 and 80),
  order_id text not null
    check (length(order_id) between 1 and 45),
  cf_payment_id text not null
    check (length(cf_payment_id) between 1 and 128),
  refund_amount_paise bigint not null
    check (refund_amount_paise > 0),
  refund_currency text not null
    check (refund_currency = 'INR'),
  created_at timestamptz not null default now()
);

create index if not exists cf_cashfree_refunds_payment_idx
  on public.cf_cashfree_refunds (cf_payment_id);

create index if not exists cf_cashfree_refunds_order_idx
  on public.cf_cashfree_refunds (order_id);

alter table public.cf_cashfree_refunds enable row level security;
revoke all on public.cf_cashfree_refunds from anon, authenticated;
grant select, insert, update, delete on public.cf_cashfree_refunds to service_role;
