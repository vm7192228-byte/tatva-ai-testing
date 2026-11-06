-- Preserve the plan attached to each video job when calculating weighted credits.
-- A later upgrade or downgrade must not re-price earlier jobs in the same month.

create or replace function public.cf_video_quota_status(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_plan_code text;
  v_expires_at timestamptz;
  v_limit integer;
  v_used integer;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_next_month_start timestamptz := v_month_start + interval '1 month';
begin
  if p_user_id is null then
    return jsonb_build_object('paid', false, 'planCode', 'free', 'used', 0, 'limit', 1, 'remaining', 1);
  end if;

  select s.plan_code, s.expires_at into v_plan_code, v_expires_at
  from public.cf_subscriptions s
  where s.user_id = p_user_id and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= now())
    and (s.expires_at is null or s.expires_at > now())
  order by s.expires_at desc nulls last
  limit 1;

  v_plan_code := coalesce(v_plan_code, 'free');
  v_limit := case v_plan_code
    when 'free' then 1
    when 'starter_monthly' then 3
    when 'pro_monthly' then 15
    when 'pro_yearly' then 15
    when 'creator_monthly' then 100
    else 0
  end;

  if v_limit = 0 then
    return jsonb_build_object('paid', false, 'planCode', v_plan_code, 'used', 0, 'limit', 0, 'remaining', 0);
  end if;

  select coalesce(sum(case
    when j.plan_code = 'creator_monthly' and j.duration_seconds >= 8 then 3
    when j.plan_code = 'creator_monthly' then 2
    when j.duration_seconds >= 8 then 2
    else 1
  end), 0)::integer
  into v_used
  from public.cf_video_jobs j
  where j.user_id = p_user_id
    and j.created_at >= v_month_start
    and j.created_at < v_next_month_start
    and j.status in ('reserved', 'queued', 'in_progress', 'succeeded');

  return jsonb_build_object(
    'paid', v_plan_code <> 'free',
    'planCode', v_plan_code,
    'expiresAt', v_expires_at,
    'used', v_used,
    'limit', v_limit,
    'remaining', greatest(v_limit - v_used, 0)
  );
end;
$function$;

create or replace function public.cf_reserve_video_job(
  p_user_id uuid,
  p_duration_seconds integer,
  p_provider text default 'wavespeed'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_plan_code text;
  v_expires_at timestamptz;
  v_limit integer;
  v_used integer;
  v_cost integer;
  v_job_id uuid;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_next_month_start timestamptz := v_month_start + interval '1 month';
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_USER');
  end if;
  if p_duration_seconds is null or p_duration_seconds not in (5, 8) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_DURATION');
  end if;
  if p_provider is distinct from 'wavespeed' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PROVIDER');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select s.plan_code, s.expires_at into v_plan_code, v_expires_at
  from public.cf_subscriptions s
  where s.user_id = p_user_id and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= now())
    and (s.expires_at is null or s.expires_at > now())
  order by s.expires_at desc nulls last
  limit 1;

  v_plan_code := coalesce(v_plan_code, 'free');
  v_limit := case v_plan_code
    when 'free' then 1
    when 'starter_monthly' then 3
    when 'pro_monthly' then 15
    when 'pro_yearly' then 15
    when 'creator_monthly' then 100
    else 0
  end;

  if v_limit = 0 then
    return jsonb_build_object('ok', false, 'error', 'PLAN_NOT_ELIGIBLE');
  end if;

  v_cost := case
    when v_plan_code = 'creator_monthly' and p_duration_seconds >= 8 then 3
    when v_plan_code = 'creator_monthly' then 2
    when p_duration_seconds >= 8 then 2
    else 1
  end;

  select coalesce(sum(case
    when j.plan_code = 'creator_monthly' and j.duration_seconds >= 8 then 3
    when j.plan_code = 'creator_monthly' then 2
    when j.duration_seconds >= 8 then 2
    else 1
  end), 0)::integer
  into v_used
  from public.cf_video_jobs j
  where j.user_id = p_user_id
    and j.created_at >= v_month_start
    and j.created_at < v_next_month_start
    and j.status in ('reserved', 'queued', 'in_progress', 'succeeded');

  if v_used + v_cost > v_limit then
    return jsonb_build_object(
      'ok', false, 'error', 'MONTHLY_LIMIT_REACHED',
      'planCode', v_plan_code, 'used', v_used, 'limit', v_limit,
      'remaining', greatest(v_limit - v_used, 0), 'requiredCredits', v_cost
    );
  end if;

  insert into public.cf_video_jobs (user_id, plan_code, provider, status, duration_seconds)
  values (p_user_id, v_plan_code, p_provider, 'reserved', p_duration_seconds)
  returning id into v_job_id;

  return jsonb_build_object(
    'ok', true, 'jobId', v_job_id, 'planCode', v_plan_code,
    'used', v_used + v_cost, 'limit', v_limit,
    'remaining', greatest(v_limit - v_used - v_cost, 0), 'creditsUsed', v_cost
  );
end;
$function$;

create or replace function public.cf_reserve_kie_video_job(
  p_user_id uuid,
  p_duration_seconds integer,
  p_idempotency_key uuid,
  p_provider_model text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_plan_code text;
  v_limit integer;
  v_used integer;
  v_cost integer;
  v_job_id uuid;
  v_existing public.cf_video_jobs%rowtype;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_next_month_start timestamptz := v_month_start + interval '1 month';
begin
  if p_user_id is null or p_idempotency_key is null
     or p_duration_seconds is distinct from 5
     or p_provider_model is null
     or p_provider_model !~ '^[A-Za-z0-9._/-]{2,120}$'
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_VIDEO_JOB_REQUEST');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select j.* into v_existing
  from public.cf_video_jobs j
  where j.user_id = p_user_id and j.idempotency_key = p_idempotency_key
  limit 1;

  if v_existing.id is not null then
    if v_existing.request_fingerprint is distinct from p_request_fingerprint
       or v_existing.provider_model is distinct from p_provider_model then
      return jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_KEY_REUSED');
    end if;
    return jsonb_build_object(
      'ok', true,
      'reused', true,
      'jobId', v_existing.id,
      'status', v_existing.status,
      'providerTaskId', v_existing.provider_task_id,
      'videoUrl', v_existing.video_url,
      'planCode', v_existing.plan_code
    );
  end if;

  select s.plan_code into v_plan_code
  from public.cf_subscriptions s
  where s.user_id = p_user_id
    and s.status = 'active'
    and (s.starts_at is null or s.starts_at <= now())
    and (s.expires_at is null or s.expires_at > now())
  order by s.expires_at desc nulls last
  limit 1;

  v_plan_code := coalesce(v_plan_code, 'free');
  v_limit := case v_plan_code
    when 'free' then 1
    when 'starter_monthly' then 3
    when 'pro_monthly' then 15
    when 'pro_yearly' then 15
    when 'creator_monthly' then 100
    else 0
  end;

  if v_limit = 0 then
    return jsonb_build_object('ok', false, 'error', 'PLAN_NOT_ELIGIBLE', 'planCode', v_plan_code);
  end if;

  v_cost := case when v_plan_code = 'creator_monthly' then 2 else 1 end;

  select coalesce(sum(case
    when j.plan_code = 'creator_monthly' and j.duration_seconds >= 8 then 3
    when j.plan_code = 'creator_monthly' then 2
    when j.duration_seconds >= 8 then 2
    else 1
  end), 0)::integer
  into v_used
  from public.cf_video_jobs j
  where j.user_id = p_user_id
    and j.created_at >= v_month_start
    and j.created_at < v_next_month_start
    and j.status in ('reserved', 'queued', 'in_progress', 'succeeded');

  if v_used + v_cost > v_limit then
    return jsonb_build_object(
      'ok', false, 'error', 'MONTHLY_LIMIT_REACHED',
      'planCode', v_plan_code, 'used', v_used, 'limit', v_limit,
      'remaining', greatest(v_limit - v_used, 0), 'requiredCredits', v_cost
    );
  end if;

  insert into public.cf_video_jobs (
    user_id, plan_code, provider, provider_model, idempotency_key,
    request_fingerprint, status, duration_seconds
  )
  values (
    p_user_id, v_plan_code, 'kie', p_provider_model, p_idempotency_key,
    p_request_fingerprint, 'reserved', p_duration_seconds
  )
  returning id into v_job_id;

  return jsonb_build_object(
    'ok', true, 'reused', false, 'jobId', v_job_id,
    'status', 'reserved', 'planCode', v_plan_code,
    'used', v_used + v_cost, 'limit', v_limit,
    'remaining', greatest(v_limit - v_used - v_cost, 0),
    'creditsUsed', v_cost
  );
end;
$function$;
