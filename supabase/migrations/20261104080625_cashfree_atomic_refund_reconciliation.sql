-- Serialize Cashfree refund events and apply full-refund revocation atomically.
-- The function runs as invoker; only service_role receives EXECUTE privileges.
create or replace function public.cf_record_cashfree_refund(
  p_refund_id text,
  p_order_id text,
  p_payment_id text,
  p_refund_amount_paise bigint,
  p_refund_currency text
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
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
     or p_refund_currency is null or p_refund_currency <> 'INR' then
    raise exception 'CASHFREE_REFUND_ARGUMENT_INVALID';
  end if;

  -- Lock the payment order so concurrent partial-refund events cannot each
  -- observe an incomplete cumulative refund amount.
  select *
    into v_order
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
    cf_refund_id,
    order_id,
    cf_payment_id,
    refund_amount_paise,
    refund_currency
  )
  values (
    p_refund_id,
    p_order_id,
    p_payment_id,
    p_refund_amount_paise,
    p_refund_currency
  )
  on conflict (cf_refund_id) do nothing;

  select *
    into v_existing
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

  -- Only a full refund of the payment that activated the subscription revokes
  -- access. Partial refunds and duplicate-payment auto-refunds do not.
  if v_total_refunded_paise = v_order.amount_paise
     and v_order.cashfree_payment_id = p_payment_id then
    update public.cf_payment_orders
       set status = 'refunded',
           updated_at = now()
     where cashfree_order_id = p_order_id
       and status = 'paid';

    update public.cf_subscriptions
       set status = 'cancelled',
           updated_at = now()
     where cashfree_order_id = p_order_id
       and cashfree_payment_id = p_payment_id
       and status = 'active';

    get diagnostics v_revoked_count = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'total_refunded_paise', v_total_refunded_paise,
    'fully_refunded', v_total_refunded_paise = v_order.amount_paise,
    'revoked', v_revoked_count > 0
  );
end;
$function$;

revoke all on function public.cf_record_cashfree_refund(text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.cf_record_cashfree_refund(text, text, text, bigint, text)
  to service_role;
