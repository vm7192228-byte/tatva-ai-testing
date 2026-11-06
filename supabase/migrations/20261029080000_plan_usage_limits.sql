-- CodeForge AI subscription entitlements and monthly usage enforcement.
create table if not exists public.cf_plan_limits (
  plan_code text not null,
  feature_code text not null,
  monthly_limit integer not null,
  updated_at timestamptz not null default now(),
  primary key (plan_code, feature_code),
  constraint cf_plan_limits_nonnegative_or_unlimited check (monthly_limit >= -1)
);

create table if not exists public.cf_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature_code text not null,
  plan_code text not null,
  created_at timestamptz not null default now()
);
create index if not exists cf_usage_events_user_feature_month_idx
  on public.cf_usage_events (user_id, feature_code, created_at desc);

alter table public.cf_plan_limits enable row level security;
alter table public.cf_usage_events enable row level security;
revoke all on public.cf_plan_limits from anon, authenticated;
revoke all on public.cf_usage_events from anon, authenticated;

insert into public.cf_plan_limits (plan_code, feature_code, monthly_limit) values
  ('free', 'social_analysis', 2),
  ('free', 'social_edit', 2),
  ('free', 'image_generation', 0),
  ('free', 'video_generation', 0),
  ('free', 'file_analysis', 3),
  ('starter_monthly', 'social_analysis', -1),
  ('starter_monthly', 'social_edit', 15),
  ('starter_monthly', 'image_generation', 0),
  ('starter_monthly', 'video_generation', 0),
  ('starter_monthly', 'file_analysis', 50),
  ('pro_monthly', 'social_analysis', -1),
  ('pro_monthly', 'social_edit', -1),
  ('pro_monthly', 'image_generation', 25),
  ('pro_monthly', 'video_generation', 10),
  ('pro_monthly', 'file_analysis', -1),
  ('pro_monthly', 'super_chat', 300),
  ('pro_yearly', 'social_analysis', -1),
  ('pro_yearly', 'social_edit', -1),
  ('pro_yearly', 'image_generation', 50),
  ('pro_yearly', 'video_generation', 30),
  ('pro_yearly', 'file_analysis', -1),
  ('pro_yearly', 'super_chat', 300)
on conflict (plan_code, feature_code) do update
set monthly_limit = excluded.monthly_limit, updated_at = now();

create or replace function public.cf_consume_usage_quota(p_user_id uuid, p_feature_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_code text := 'free';
  v_limit integer;
  v_used integer;
  v_now timestamptz := now();
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_user_id is null or p_feature_code not in ('social_analysis', 'social_edit', 'image_generation', 'video_generation', 'file_analysis', 'super_chat') then
    return jsonb_build_object('allowed', false, 'error', 'INVALID_QUOTA_REQUEST');
  end if;

  select s.plan_code into v_plan_code
  from public.cf_subscriptions s
  where s.user_id = p_user_id and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= v_now)
    and (s.expires_at is null or s.expires_at > v_now)
  order by s.expires_at desc nulls last
  limit 1;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(p_feature_code));
  v_plan_code := coalesce(v_plan_code, 'free');
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

  if v_limit = 0 or (v_limit > 0 and v_used >= v_limit) then
    return jsonb_build_object('allowed', false, 'planCode', v_plan_code, 'limit', v_limit, 'used', v_used, 'remaining', 0);
  end if;

  insert into public.cf_usage_events (user_id, feature_code, plan_code)
  values (p_user_id, p_feature_code, v_plan_code);

  return jsonb_build_object(
    'allowed', true, 'planCode', v_plan_code, 'limit', v_limit,
    'used', v_used + 1, 'remaining', case when v_limit = -1 then -1 else greatest(v_limit - v_used - 1, 0) end
  );
end;
$$;

revoke all on function public.cf_consume_usage_quota(uuid, text) from public, anon, authenticated;
grant execute on function public.cf_consume_usage_quota(uuid, text) to service_role;
