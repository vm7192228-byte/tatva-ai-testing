-- Usage accounting for subscription-gated Wan 2.2 video generation.
-- Only the server-side service role can access this table or execute quota functions.

create table if not exists public.cf_video_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  plan_code text not null,
  provider text not null default 'wavespeed',
  provider_task_id text unique,
  status text not null default 'reserved'
    check (status in ('reserved', 'queued', 'in_progress', 'succeeded', 'failed')),
  duration_seconds integer not null check (duration_seconds in (5, 8)),
  video_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cf_video_jobs_user_created_idx
  on public.cf_video_jobs (user_id, created_at desc);
create index if not exists cf_video_jobs_user_status_created_idx
  on public.cf_video_jobs (user_id, status, created_at desc);

alter table public.cf_video_jobs enable row level security;
revoke all on public.cf_video_jobs from public, anon, authenticated;
grant all on public.cf_video_jobs to service_role;

create or replace function public.cf_video_quota_status(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_code text;
  v_starts_at timestamptz;
  v_expires_at timestamptz;
  v_limit integer;
  v_used integer;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  select s.plan_code, s.starts_at, s.expires_at
    into v_plan_code, v_starts_at, v_expires_at
  from public.cf_subscriptions s
  where s.user_id = p_user_id
    and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= now())
    and (s.expires_at is null or s.expires_at > now())
  order by s.expires_at desc nulls last
  limit 1;

  if v_plan_code is null then
    return jsonb_build_object('paid', false, 'planCode', null, 'used', 0, 'limit', 0, 'remaining', 0);
  end if;

  v_limit := case v_plan_code
    when 'starter_monthly' then 3
    when 'pro_monthly' then 8
    when 'pro_yearly' then 8
    else 0
  end;

  if v_limit = 0 then
    return jsonb_build_object('paid', false, 'planCode', null, 'used', 0, 'limit', 0, 'remaining', 0);
  end if;

  select count(*)::integer into v_used
  from public.cf_video_jobs j
  where j.user_id = p_user_id
    and j.created_at >= v_month_start
    and j.status in ('reserved', 'queued', 'in_progress', 'succeeded');

  return jsonb_build_object(
    'paid', true,
    'planCode', v_plan_code,
    'expiresAt', v_expires_at,
    'used', v_used,
    'limit', v_limit,
    'remaining', greatest(v_limit - v_used, 0)
  );
end;
$$;

create or replace function public.cf_reserve_video_job(
  p_user_id uuid,
  p_duration_seconds integer,
  p_provider text default 'wavespeed'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_code text;
  v_starts_at timestamptz;
  v_expires_at timestamptz;
  v_limit integer;
  v_used integer;
  v_job_id uuid;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_duration_seconds not in (5, 8) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_DURATION');
  end if;
  if p_provider <> 'wavespeed' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PROVIDER');
  end if;

  -- Serialize reservations per user so parallel requests cannot exceed their monthly cap.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select s.plan_code, s.starts_at, s.expires_at
    into v_plan_code, v_starts_at, v_expires_at
  from public.cf_subscriptions s
  where s.user_id = p_user_id
    and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= now())
    and (s.expires_at is null or s.expires_at > now())
  order by s.expires_at desc nulls last
  limit 1;

  if v_plan_code is null then
    return jsonb_build_object('ok', false, 'error', 'SUBSCRIPTION_REQUIRED');
  end if;

  v_limit := case v_plan_code
    when 'starter_monthly' then 3
    when 'pro_monthly' then 8
    when 'pro_yearly' then 8
    else 0
  end;
  if v_limit = 0 then
    return jsonb_build_object('ok', false, 'error', 'PLAN_NOT_ELIGIBLE');
  end if;

  select count(*)::integer into v_used
  from public.cf_video_jobs j
  where j.user_id = p_user_id
    and j.created_at >= v_month_start
    and j.status in ('reserved', 'queued', 'in_progress', 'succeeded');

  if v_used >= v_limit then
    return jsonb_build_object('ok', false, 'error', 'MONTHLY_LIMIT_REACHED',
      'planCode', v_plan_code, 'used', v_used, 'limit', v_limit, 'remaining', 0);
  end if;

  insert into public.cf_video_jobs (user_id, plan_code, provider, status, duration_seconds)
  values (p_user_id, v_plan_code, p_provider, 'reserved', p_duration_seconds)
  returning id into v_job_id;

  return jsonb_build_object('ok', true, 'jobId', v_job_id, 'planCode', v_plan_code,
    'used', v_used + 1, 'limit', v_limit, 'remaining', greatest(v_limit - v_used - 1, 0));
end;
$$;

revoke all on function public.cf_video_quota_status(uuid) from public, anon, authenticated;
revoke all on function public.cf_reserve_video_job(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.cf_video_quota_status(uuid) to service_role;
grant execute on function public.cf_reserve_video_job(uuid, integer, text) to service_role;
