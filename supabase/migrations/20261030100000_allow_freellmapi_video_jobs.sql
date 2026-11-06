-- Allow the same monthly video-credit ledger to reserve and track FreeLLMAPI videos.
-- The request still runs through the private server-side gateway and all provider keys remain server-only.
create or replace function public.cf_reserve_video_job(
  p_user_id uuid,
  p_duration_seconds integer,
  p_provider text default 'wavespeed'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan_code text;
  v_expires_at timestamptz;
  v_limit integer;
  v_used integer;
  v_cost integer;
  v_job_id uuid;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_duration_seconds not in (5,8) then
    return jsonb_build_object('ok',false,'error','INVALID_DURATION');
  end if;
  if p_provider not in ('wavespeed','freellmapi') then
    return jsonb_build_object('ok',false,'error','INVALID_PROVIDER');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));

  select s.plan_code,s.expires_at into v_plan_code,v_expires_at
  from public.cf_subscriptions s
  where s.user_id=p_user_id and s.status='active'
    and (s.starts_at is null or s.starts_at<=now())
    and (s.expires_at is null or s.expires_at>now())
  order by s.expires_at desc nulls last limit 1;

  v_plan_code:=coalesce(v_plan_code,'free');
  v_limit:=case v_plan_code
    when 'free' then 1
    when 'starter_monthly' then 3
    when 'pro_monthly' then 15
    when 'pro_yearly' then 15
    when 'creator_monthly' then 100
    else 0
  end;
  if v_limit=0 then
    return jsonb_build_object('ok',false,'error','PLAN_NOT_ELIGIBLE');
  end if;

  v_cost:=case
    when v_plan_code='creator_monthly' and p_duration_seconds>=8 then 3
    when v_plan_code='creator_monthly' then 2
    when p_duration_seconds>=8 then 2
    else 1
  end;

  select coalesce(sum(case
    when v_plan_code='creator_monthly' and j.duration_seconds>=8 then 3
    when v_plan_code='creator_monthly' then 2
    when j.duration_seconds>=8 then 2
    else 1
  end),0)::integer
  into v_used
  from public.cf_video_jobs j
  where j.user_id=p_user_id and j.created_at>=v_month_start
    and j.status in ('reserved','queued','in_progress','succeeded');

  if v_used+v_cost>v_limit then
    return jsonb_build_object(
      'ok',false,'error','MONTHLY_LIMIT_REACHED','planCode',v_plan_code,
      'used',v_used,'limit',v_limit,'remaining',greatest(v_limit-v_used,0),
      'requiredCredits',v_cost
    );
  end if;

  insert into public.cf_video_jobs(user_id,plan_code,provider,status,duration_seconds)
  values(p_user_id,v_plan_code,p_provider,'reserved',p_duration_seconds)
  returning id into v_job_id;

  return jsonb_build_object(
    'ok',true,'jobId',v_job_id,'planCode',v_plan_code,
    'used',v_used+v_cost,'limit',v_limit,
    'remaining',greatest(v_limit-v_used-v_cost,0),'creditsUsed',v_cost
  );
end;
$function$;
