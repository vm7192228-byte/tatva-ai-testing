-- Atomically reserve metered CodeForge quota before contacting external providers.
-- Reservations are committed only after CodeForge validates a successful result.
-- RLS and explicit grants keep reservation data private; RPCs run as service_role.
create table if not exists public.cf_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature_code text not null check (
    feature_code in ('social_analysis', 'social_edit', 'image_generation', 'video_generation', 'file_analysis', 'super_chat')
  ),
  plan_code text not null,
  idempotency_key uuid not null,
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  constraint cf_usage_reservations_idempotency_unique
    unique (user_id, feature_code, idempotency_key)
);

create index if not exists cf_usage_reservations_active_quota_idx
  on public.cf_usage_reservations (user_id, feature_code, created_at, expires_at)
  where status = 'reserved';

alter table public.cf_usage_reservations enable row level security;
revoke all on public.cf_usage_reservations from public, anon, authenticated;

-- The legacy consume RPC also counts in-flight reservations so a request using
-- the old code path cannot overspend a feature while a reservation is pending.
create or replace function public.cf_consume_usage_quota(p_user_id uuid, p_feature_code text)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_plan_code text := 'free';
  v_limit integer;
  v_used integer;
  v_reserved integer;
  v_total integer;
  v_now timestamptz := now();
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_user_id is null or p_feature_code is null or p_feature_code not in ('social_analysis', 'social_edit', 'image_generation', 'video_generation', 'file_analysis', 'super_chat') then
    return jsonb_build_object('allowed', false, 'error', 'INVALID_QUOTA_REQUEST');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(p_feature_code));

  select s.plan_code into v_plan_code
  from public.cf_subscriptions s
  where s.user_id = p_user_id and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= v_now)
    and (s.expires_at is null or s.expires_at > v_now)
  order by s.expires_at desc nulls last
  limit 1;
  v_plan_code := coalesce(v_plan_code, 'free');

  update public.cf_usage_reservations
  set status = 'released', updated_at = v_now
  where user_id = p_user_id and feature_code = p_feature_code
    and status = 'reserved' and expires_at <= v_now;

  select l.monthly_limit into v_limit
  from public.cf_plan_limits l
  where l.plan_code = v_plan_code and l.feature_code = p_feature_code;

  if v_limit is null then
    return jsonb_build_object('allowed', false, 'error', 'QUOTA_NOT_CONFIGURED', 'planCode', v_plan_code);
  end if;

  select count(*)::integer into v_used
  from public.cf_usage_events e
  where e.user_id = p_user_id and e.feature_code = p_feature_code
    and e.created_at >= v_month_start and e.created_at < v_month_start + interval '1 month';

  select count(*)::integer into v_reserved
  from public.cf_usage_reservations r
  where r.user_id = p_user_id and r.feature_code = p_feature_code
    and r.status = 'reserved' and r.expires_at > v_now
    and r.created_at >= v_month_start and r.created_at < v_month_start + interval '1 month';

  v_total := v_used + v_reserved;
  if v_limit = 0 or (v_limit > 0 and v_total >= v_limit) then
    return jsonb_build_object('allowed', false, 'error', 'MONTHLY_LIMIT_REACHED', 'planCode', v_plan_code, 'limit', v_limit, 'used', v_total, 'remaining', 0);
  end if;

  insert into public.cf_usage_events (user_id, feature_code, plan_code)
  values (p_user_id, p_feature_code, v_plan_code);

  return jsonb_build_object(
    'allowed', true, 'planCode', v_plan_code, 'limit', v_limit,
    'used', v_total + 1, 'remaining', case when v_limit = -1 then -1 else greatest(v_limit - v_total - 1, 0) end
  );
end;
$$;

create or replace function public.cf_reserve_usage_quota(
  p_user_id uuid,
  p_feature_code text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_plan_code text := 'free';
  v_limit integer;
  v_used integer;
  v_reserved integer;
  v_total integer;
  v_now timestamptz := now();
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_existing_id uuid;
  v_existing_status text;
  v_reservation_id uuid;
begin
  if p_user_id is null
    or p_feature_code is null
    or p_idempotency_key is null
    or p_feature_code not in ('social_analysis', 'social_edit', 'image_generation', 'video_generation', 'file_analysis', 'super_chat')
  then
    return jsonb_build_object('allowed', false, 'error', 'INVALID_QUOTA_REQUEST');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(p_feature_code));

  select s.plan_code into v_plan_code
  from public.cf_subscriptions s
  where s.user_id = p_user_id and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= v_now)
    and (s.expires_at is null or s.expires_at > v_now)
  order by s.expires_at desc nulls last
  limit 1;
  v_plan_code := coalesce(v_plan_code, 'free');

  update public.cf_usage_reservations
  set status = 'released', updated_at = v_now
  where user_id = p_user_id and feature_code = p_feature_code
    and status = 'reserved' and expires_at <= v_now;

  select r.id, r.status into v_existing_id, v_existing_status
  from public.cf_usage_reservations r
  where r.user_id = p_user_id and r.feature_code = p_feature_code
    and r.idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
    return jsonb_build_object(
      'allowed', false,
      'error', 'IDEMPOTENCY_KEY_REUSED',
      'reservationId', v_existing_id,
      'status', v_existing_status
    );
  end if;

  select l.monthly_limit into v_limit
  from public.cf_plan_limits l
  where l.plan_code = v_plan_code and l.feature_code = p_feature_code;

  if v_limit is null then
    return jsonb_build_object('allowed', false, 'error', 'QUOTA_NOT_CONFIGURED', 'planCode', v_plan_code);
  end if;

  select count(*)::integer into v_used
  from public.cf_usage_events e
  where e.user_id = p_user_id and e.feature_code = p_feature_code
    and e.created_at >= v_month_start and e.created_at < v_month_start + interval '1 month';

  select count(*)::integer into v_reserved
  from public.cf_usage_reservations r
  where r.user_id = p_user_id and r.feature_code = p_feature_code
    and r.status = 'reserved' and r.expires_at > v_now
    and r.created_at >= v_month_start and r.created_at < v_month_start + interval '1 month';

  v_total := v_used + v_reserved;
  if v_limit = 0 or (v_limit > 0 and v_total >= v_limit) then
    return jsonb_build_object('allowed', false, 'planCode', v_plan_code, 'limit', v_limit, 'used', v_total, 'remaining', 0);
  end if;

  insert into public.cf_usage_reservations (
    user_id, feature_code, plan_code, idempotency_key, status, expires_at
  )
  values (
    p_user_id, p_feature_code, v_plan_code, p_idempotency_key, 'reserved', v_now + interval '15 minutes'
  )
  returning id into v_reservation_id;

  return jsonb_build_object(
    'allowed', true,
    'reservationId', v_reservation_id,
    'planCode', v_plan_code,
    'limit', v_limit,
    'used', v_total + 1,
    'remaining', case when v_limit = -1 then -1 else greatest(v_limit - v_total - 1, 0) end
  );
end;
$$;

create or replace function public.cf_finalize_usage_quota(
  p_user_id uuid,
  p_reservation_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_feature_code text;
  v_status text;
  v_plan_code text;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_now timestamptz := now();
begin
  if p_user_id is null or p_reservation_id is null or p_action is null or p_action not in ('commit', 'release') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_FINALIZATION_REQUEST');
  end if;

  select r.feature_code into v_feature_code
  from public.cf_usage_reservations r
  where r.id = p_reservation_id and r.user_id = p_user_id;

  if v_feature_code is null then
    return jsonb_build_object('ok', false, 'error', 'RESERVATION_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(v_feature_code));

  select r.status, r.plan_code, r.created_at, r.expires_at
  into v_status, v_plan_code, v_created_at, v_expires_at
  from public.cf_usage_reservations r
  where r.id = p_reservation_id and r.user_id = p_user_id
  for update;

  if v_status is null then
    return jsonb_build_object('ok', false, 'error', 'RESERVATION_NOT_FOUND');
  end if;

  if v_status = 'committed' and p_action = 'commit' then
    return jsonb_build_object('ok', true, 'status', 'committed', 'alreadyFinalized', true);
  end if;
  if v_status = 'released' and p_action = 'release' then
    return jsonb_build_object('ok', true, 'status', 'released', 'alreadyFinalized', true);
  end if;
  if v_status <> 'reserved' then
    return jsonb_build_object('ok', false, 'error', 'RESERVATION_ALREADY_FINALIZED', 'status', v_status);
  end if;

  if v_expires_at <= v_now then
    update public.cf_usage_reservations
    set status = 'released', updated_at = v_now
    where id = p_reservation_id;
    return jsonb_build_object('ok', false, 'error', 'RESERVATION_EXPIRED');
  end if;

  if p_action = 'commit' then
    insert into public.cf_usage_events (user_id, feature_code, plan_code, created_at)
    values (p_user_id, v_feature_code, v_plan_code, v_created_at);
    update public.cf_usage_reservations
    set status = 'committed', updated_at = v_now
    where id = p_reservation_id;
    return jsonb_build_object('ok', true, 'status', 'committed');
  end if;

  update public.cf_usage_reservations
  set status = 'released', updated_at = v_now
  where id = p_reservation_id;
  return jsonb_build_object('ok', true, 'status', 'released');
end;
$$;

-- The RPCs execute as the server's service_role, so grant only the table
-- operations those functions require. No browser-facing role gets table access.
grant select, insert, update on table public.cf_usage_reservations to service_role;
grant select on table public.cf_plan_limits to service_role;
grant select on table public.cf_subscriptions to service_role;
grant select, insert on table public.cf_usage_events to service_role;

revoke all on function public.cf_consume_usage_quota(uuid, text) from public, anon, authenticated;
revoke all on function public.cf_reserve_usage_quota(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.cf_finalize_usage_quota(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cf_consume_usage_quota(uuid, text) to service_role;
grant execute on function public.cf_reserve_usage_quota(uuid, text, uuid) to service_role;
grant execute on function public.cf_finalize_usage_quota(uuid, uuid, text) to service_role;
