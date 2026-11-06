-- Serialize Cashfree payment activation with successful refund reconciliation.
-- Refund and activation both lock the payment-order row, so delivery order cannot
-- create an active subscription for a payment that has already been fully refunded.

create or replace function public.cf_activate_cashfree_subscription(
  p_order_id text,
  p_payment_id text,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_order public.cf_payment_orders%rowtype;
  v_existing public.cf_subscriptions%rowtype;
  v_total_refunded_paise bigint;
begin
  if p_order_id is null or length(p_order_id) < 1 or length(p_order_id) > 45
     or p_payment_id is null or length(p_payment_id) < 1 or length(p_payment_id) > 128
     or p_starts_at is null or p_expires_at is null or p_expires_at <= p_starts_at then
    raise exception 'CASHFREE_ACTIVATION_ARGUMENT_INVALID';
  end if;

  select * into v_order
    from public.cf_payment_orders
   where cashfree_order_id = p_order_id
   for update;

  if not found then
    raise exception 'CASHFREE_ACTIVATION_ORDER_NOT_FOUND';
  end if;

  if v_order.status = 'refunded' then
    return jsonb_build_object('ok', false, 'error', 'PAYMENT_ALREADY_REFUNDED');
  end if;

  if v_order.status not in ('created', 'failed', 'paid') then
    return jsonb_build_object('ok', false, 'error', 'PAYMENT_ORDER_NOT_ACTIVATABLE');
  end if;

  if v_order.cashfree_payment_id is not null
     and v_order.cashfree_payment_id <> p_payment_id then
    return jsonb_build_object('ok', false, 'error', 'BILLING_ORDER_PAYMENT_MISMATCH');
  end if;

  select coalesce(sum(r.refund_amount_paise), 0)
    into v_total_refunded_paise
    from public.cf_cashfree_refunds r
   where r.order_id = p_order_id
     and r.cf_payment_id = p_payment_id
     and r.refund_currency = v_order.currency;

  if v_total_refunded_paise >= v_order.amount_paise then
    update public.cf_payment_orders
       set status = 'refunded',
           cashfree_payment_id = p_payment_id,
           paid_at = coalesce(paid_at, now()),
           updated_at = now()
     where cashfree_order_id = p_order_id;

    return jsonb_build_object('ok', false, 'error', 'PAYMENT_ALREADY_REFUNDED');
  end if;

  update public.cf_payment_orders
     set status = 'paid',
         cashfree_payment_id = p_payment_id,
         paid_at = coalesce(paid_at, p_starts_at),
         updated_at = now()
   where cashfree_order_id = p_order_id;

  select * into v_existing
    from public.cf_subscriptions
   where cashfree_order_id = p_order_id
   for update;

  if found then
    if v_existing.cashfree_payment_id is not null
       and v_existing.cashfree_payment_id <> p_payment_id then
      raise exception 'BILLING_SUBSCRIPTION_PAYMENT_MISMATCH';
    end if;

    if v_existing.cashfree_payment_id is null then
      update public.cf_subscriptions
         set cashfree_payment_id = p_payment_id,
             updated_at = now()
       where id = v_existing.id;
    end if;

    return jsonb_build_object(
      'ok', true, 'reused', true,
      'subscriptionId', v_existing.id, 'status', v_existing.status
    );
  end if;

  insert into public.cf_subscriptions (
    user_id, plan_code, status, starts_at, expires_at,
    cashfree_order_id, cashfree_payment_id, updated_at
  )
  values (
    v_order.user_id, v_order.plan_code, 'active', p_starts_at, p_expires_at,
    p_order_id, p_payment_id, now()
  )
  on conflict (cashfree_order_id) where cashfree_order_id is not null do nothing;

  select * into v_existing
    from public.cf_subscriptions
   where cashfree_order_id = p_order_id
   for update;

  if not found or v_existing.cashfree_payment_id is distinct from p_payment_id then
    raise exception 'BILLING_SUBSCRIPTION_ACTIVATION_CONFLICT';
  end if;

  return jsonb_build_object(
    'ok', true, 'reused', false,
    'subscriptionId', v_existing.id, 'status', v_existing.status
  );
end;
$function$;

revoke all on function public.cf_activate_cashfree_subscription(text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cf_activate_cashfree_subscription(text, text, timestamptz, timestamptz)
  to service_role;

drop function if exists public.cf_record_cashfree_refund(text, text, text, bigint, text);

create function public.cf_record_cashfree_refund(
  p_refund_id text,
  p_order_id text,
  p_payment_id text,
  p_refund_amount_paise bigint,
  p_refund_currency text,
  p_is_auto_refund boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_order public.cf_payment_orders%rowtype;
  v_existing public.cf_cashfree_refunds%rowtype;
  v_total_refunded_paise bigint;
  v_revoked_count integer := 0;
begin
  if p_refund_id is null or length(p_refund_id) < 1 or length(p_refund_id) > 80
     or p_order_id is null or length(p_order_id) < 1 or length(p_order_id) > 45
     or p_payment_id is null or length(p_payment_id) < 1 or length(p_payment_id) > 128
     or p_refund_amount_paise is null or p_refund_amount_paise <= 0
     or p_refund_currency is null or p_refund_currency <> 'INR'
     or p_is_auto_refund is null then
    raise exception 'CASHFREE_REFUND_ARGUMENT_INVALID';
  end if;

  select * into v_order
    from public.cf_payment_orders
   where cashfree_order_id = p_order_id
   for update;

  if not found then
    raise exception 'CASHFREE_REFUND_ORDER_NOT_FOUND';
  end if;

  if p_refund_currency <> v_order.currency
     or p_refund_amount_paise > v_order.amount_paise then
    raise exception 'CASHFREE_REFUND_DETAILS_MISMATCH';
  end if;

  insert into public.cf_cashfree_refunds (
    cf_refund_id, order_id, cf_payment_id, refund_amount_paise, refund_currency
  )
  values (
    p_refund_id, p_order_id, p_payment_id, p_refund_amount_paise, p_refund_currency
  )
  on conflict (cf_refund_id) do nothing;

  select * into v_existing
    from public.cf_cashfree_refunds
   where cf_refund_id = p_refund_id;

  if not found
     or v_existing.order_id <> p_order_id
     or v_existing.cf_payment_id <> p_payment_id
     or v_existing.refund_amount_paise <> p_refund_amount_paise
     or v_existing.refund_currency <> p_refund_currency then
    raise exception 'CASHFREE_REFUND_IDEMPOTENCY_CONFLICT';
  end if;

  select coalesce(sum(refund_amount_paise), 0)
    into v_total_refunded_paise
    from public.cf_cashfree_refunds
   where order_id = p_order_id
     and cf_payment_id = p_payment_id
     and refund_currency = p_refund_currency;

  if v_total_refunded_paise > v_order.amount_paise then
    raise exception 'CASHFREE_REFUND_TOTAL_EXCEEDS_ORDER';
  end if;

  if v_total_refunded_paise = v_order.amount_paise then
    if v_order.cashfree_payment_id = p_payment_id then
      update public.cf_payment_orders
         set status = 'refunded', updated_at = now()
       where cashfree_order_id = p_order_id
         and status = 'paid';

      update public.cf_subscriptions
         set status = 'cancelled', updated_at = now()
       where cashfree_order_id = p_order_id
         and cashfree_payment_id = p_payment_id
         and status = 'active';

      get diagnostics v_revoked_count = row_count;
    elsif v_order.cashfree_payment_id is null and not p_is_auto_refund
          and v_order.status in ('created', 'failed', 'paid') then
      -- The original payment's refund may be delivered before its payment
      -- success event. Persist a terminal order marker so activation cannot
      -- later create an entitlement for this already-refunded payment.
      update public.cf_payment_orders
         set status = 'refunded',
             cashfree_payment_id = p_payment_id,
             paid_at = coalesce(paid_at, now()),
             updated_at = now()
       where cashfree_order_id = p_order_id
         and status in ('created', 'failed', 'paid')
         and cashfree_payment_id is null;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'total_refunded_paise', v_total_refunded_paise,
    'fully_refunded', v_total_refunded_paise = v_order.amount_paise,
    'revoked', v_revoked_count > 0
  );
end;
$function$;

revoke all on function public.cf_record_cashfree_refund(text, text, text, bigint, text, boolean)
  from public, anon, authenticated;
grant execute on function public.cf_record_cashfree_refund(text, text, text, bigint, text, boolean)
  to service_role;
