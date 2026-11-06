BEGIN;

-- The KIE video route reserves credits through this RPC, not cf_plan_limits.
-- Keep the reservation ledger aligned with the public Free / Plus / Max plans.
CREATE OR REPLACE FUNCTION public.cf_reserve_kie_video_job(
  p_user_id uuid,
  p_duration_seconds integer,
  p_idempotency_key uuid,
  p_provider_model text,
  p_request_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_plan_code text;
  v_limit integer;
  v_used integer;
  v_cost integer;
  v_job_id uuid;
  v_existing public.cf_video_jobs%rowtype;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_next_month_start timestamptz := v_month_start + interval '1 month';
BEGIN
  IF p_user_id IS NULL OR p_idempotency_key IS NULL
     OR p_duration_seconds IS DISTINCT FROM 5
     OR p_provider_model IS NULL
     OR p_provider_model !~ '^[A-Za-z0-9._/-]{2,120}$'
     OR p_request_fingerprint IS NULL
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_VIDEO_JOB_REQUEST');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT j.* INTO v_existing
  FROM public.cf_video_jobs j
  WHERE j.user_id = p_user_id AND j.idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.provider_model IS DISTINCT FROM p_provider_model
    THEN
      RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_KEY_REUSED');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'reused', true,
      'jobId', v_existing.id,
      'status', v_existing.status,
      'providerTaskId', v_existing.provider_task_id,
      'videoUrl', v_existing.video_url,
      'planCode', v_existing.plan_code
    );
  END IF;

  SELECT s.plan_code INTO v_plan_code
  FROM public.cf_subscriptions s
  WHERE s.user_id = p_user_id
    AND s.status = 'active'
    AND (s.starts_at IS NULL OR s.starts_at <= now())
    AND (s.expires_at IS NULL OR s.expires_at > now())
  ORDER BY s.expires_at DESC NULLS LAST
  LIMIT 1;

  v_plan_code := coalesce(v_plan_code, 'free');
  v_limit := CASE v_plan_code
    WHEN 'free' THEN 0
    WHEN 'starter_monthly' THEN 3
    WHEN 'pro_monthly' THEN 3
    WHEN 'pro_yearly' THEN 3
    WHEN 'creator_monthly' THEN 24
    ELSE 0
  END;

  IF v_limit = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PLAN_NOT_ELIGIBLE', 'planCode', v_plan_code);
  END IF;

  -- Plus uses 1 credit per 5-second clip; Max uses 2 credits per clip.
  v_cost := CASE WHEN v_plan_code = 'creator_monthly' THEN 2 ELSE 1 END;

  SELECT coalesce(sum(CASE
    WHEN j.plan_code = 'creator_monthly' AND j.duration_seconds >= 8 THEN 3
    WHEN j.plan_code = 'creator_monthly' THEN 2
    WHEN j.duration_seconds >= 8 THEN 2
    ELSE 1
  END), 0)::integer
  INTO v_used
  FROM public.cf_video_jobs j
  WHERE j.user_id = p_user_id
    AND j.created_at >= v_month_start
    AND j.created_at < v_next_month_start
    AND j.status IN ('reserved', 'queued', 'in_progress', 'succeeded');

  IF v_used + v_cost > v_limit THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'MONTHLY_LIMIT_REACHED',
      'planCode', v_plan_code, 'used', v_used, 'limit', v_limit,
      'remaining', greatest(v_limit - v_used, 0), 'requiredCredits', v_cost
    );
  END IF;

  INSERT INTO public.cf_video_jobs (
    user_id, plan_code, provider, provider_model, idempotency_key,
    request_fingerprint, status, duration_seconds
  )
  VALUES (
    p_user_id, v_plan_code, 'kie', p_provider_model, p_idempotency_key,
    p_request_fingerprint, 'reserved', p_duration_seconds
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object(
    'ok', true, 'reused', false, 'jobId', v_job_id,
    'status', 'reserved', 'planCode', v_plan_code,
    'used', v_used + v_cost, 'limit', v_limit,
    'remaining', greatest(v_limit - v_used - v_cost, 0),
    'creditsUsed', v_cost
  );
END;
$function$;

-- Monthly file-analysis allowances.
UPDATE public.cf_plan_limits
SET monthly_limit = 3
WHERE plan_code = 'free' AND feature_code = 'file_analysis';

UPDATE public.cf_plan_limits
SET monthly_limit = 20
WHERE plan_code IN ('pro_monthly', 'pro_yearly') AND feature_code = 'file_analysis';

UPDATE public.cf_plan_limits
SET monthly_limit = 60
WHERE plan_code = 'creator_monthly' AND feature_code = 'file_analysis';

-- Monthly image-generation allowances.
UPDATE public.cf_plan_limits
SET monthly_limit = 2
WHERE plan_code = 'free' AND feature_code = 'image_generation';

UPDATE public.cf_plan_limits
SET monthly_limit = 20
WHERE plan_code IN ('pro_monthly', 'pro_yearly') AND feature_code = 'image_generation';

UPDATE public.cf_plan_limits
SET monthly_limit = 60
WHERE plan_code = 'creator_monthly' AND feature_code = 'image_generation';

-- Video credit allowances mirror the atomic KIE reservation function above.
UPDATE public.cf_plan_limits
SET monthly_limit = 0
WHERE plan_code = 'free' AND feature_code = 'video_generation';

UPDATE public.cf_plan_limits
SET monthly_limit = 3
WHERE plan_code IN ('pro_monthly', 'pro_yearly') AND feature_code = 'video_generation';

UPDATE public.cf_plan_limits
SET monthly_limit = 24
WHERE plan_code = 'creator_monthly' AND feature_code = 'video_generation';

-- Chat is included on every plan. Provider fair-use and gateway rate limits remain separate.
UPDATE public.cf_plan_limits
SET monthly_limit = -1
WHERE plan_code IN ('free', 'pro_monthly', 'pro_yearly', 'creator_monthly')
  AND feature_code = 'super_chat';

COMMIT;
