-- Shared, owner/privacy-preserving voice transcription rate limits.
-- The application stores only a SHA-256 subject hash; raw user IDs and IP addresses are never persisted.
create table if not exists public.cf_transcription_rate_limits (
  subject_hash text primary key
    check (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count > 0),
  updated_at timestamptz not null default now()
);

create index if not exists cf_transcription_rate_limits_updated_idx
  on public.cf_transcription_rate_limits(updated_at);

alter table public.cf_transcription_rate_limits enable row level security;
revoke all on public.cf_transcription_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.cf_transcription_rate_limits to service_role;

create or replace function public.cf_allow_transcription_attempt(
  p_subject_hash text,
  p_max_attempts integer,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_window_started timestamptz;
  v_attempt_count integer;
  v_reset_at timestamptz;
begin
  if p_subject_hash is null
     or p_subject_hash !~ '^[0-9a-f]{64}$'
     or p_max_attempts is null
     or p_max_attempts < 1
     or p_max_attempts > 100
     or p_window_seconds is null
     or p_window_seconds < 1
     or p_window_seconds > 3600 then
    return jsonb_build_object('allowed', false, 'error', 'INVALID_RATE_LIMIT_REQUEST');
  end if;

  insert into public.cf_transcription_rate_limits(
    subject_hash, window_started_at, attempt_count, updated_at
  )
  values (p_subject_hash, v_now, 1, v_now)
  on conflict (subject_hash) do update
  set
    window_started_at = case
      when public.cf_transcription_rate_limits.window_started_at
        + make_interval(secs => p_window_seconds) <= v_now then v_now
      else public.cf_transcription_rate_limits.window_started_at
    end,
    attempt_count = case
      when public.cf_transcription_rate_limits.window_started_at
        + make_interval(secs => p_window_seconds) <= v_now then 1
      else public.cf_transcription_rate_limits.attempt_count + 1
    end,
    updated_at = v_now
  returning window_started_at, attempt_count
  into v_window_started, v_attempt_count;

  v_reset_at := v_window_started + make_interval(secs => p_window_seconds);

  -- Probabilistic cleanup keeps this small high-churn table bounded without
  -- making every request scan and delete stale subjects.
  if random() < 0.01 then
    delete from public.cf_transcription_rate_limits
    where updated_at < v_now - interval '2 days';
  end if;

  return jsonb_build_object(
    'allowed', v_attempt_count <= p_max_attempts,
    'attempts', v_attempt_count,
    'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_reset_at - v_now)))::integer)
  );
end;
$function$;

revoke all on function public.cf_allow_transcription_attempt(text, integer, integer) from public, anon, authenticated;
grant execute on function public.cf_allow_transcription_attempt(text, integer, integer) to service_role;
