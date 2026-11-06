-- Durable, owner-scoped chat generation state and replayable SSE events.
-- The browser never receives database write access; all RPCs are service-role only.

create table if not exists public.cf_chat_generations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  idempotency_key uuid not null,
  provider text not null,
  provider_started_at timestamptz,
  status text not null default 'running'
    check (status in ('running','cancel_requested','completed','failed','cancelled','expired')),
  status_message text,
  last_event_seq bigint not null default 0 check (last_event_seq >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  unique (user_id, idempotency_key)
);

create index if not exists cf_chat_generations_user_updated_idx
  on public.cf_chat_generations(user_id, updated_at desc);
create index if not exists cf_chat_generations_user_created_idx
  on public.cf_chat_generations(user_id, created_at desc);
create index if not exists cf_chat_generations_expiry_idx
  on public.cf_chat_generations(expires_at);

create table if not exists public.cf_chat_generation_events (
  generation_id uuid not null references public.cf_chat_generations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seq bigint not null check (seq > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (generation_id, seq),
  constraint cf_chat_generation_event_payload_size check (octet_length(payload::text) <= 32768)
);

create index if not exists cf_chat_generation_events_user_created_idx
  on public.cf_chat_generation_events(user_id, created_at desc);

alter table public.cf_chat_generations enable row level security;
alter table public.cf_chat_generation_events enable row level security;
revoke all on public.cf_chat_generations from anon, authenticated;
revoke all on public.cf_chat_generation_events from anon, authenticated;
grant all on public.cf_chat_generations to service_role;
grant all on public.cf_chat_generation_events to service_role;

create or replace function public.cf_create_chat_generation(
  p_user_id uuid,
  p_generation_id uuid,
  p_conversation_id uuid,
  p_idempotency_key uuid,
  p_provider text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_generation public.cf_chat_generations%rowtype;
begin
  if p_user_id is null or p_generation_id is null or p_conversation_id is null or p_idempotency_key is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ARGUMENTS');
  end if;
  if p_provider not in ('smart','gemini','openai','anthropic','deepseek','xai','cloudflare','pollinations','freellmapi') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_PROVIDER');
  end if;

  -- Serialize generation creation for each account so concurrent requests
  -- cannot bypass the per-user caps below.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- Opportunistic retention cleanup. A scheduled cleanup can be added later.
  delete from public.cf_chat_generations where expires_at < now();

  -- Idempotent retries return the existing generation without consuming a new
  -- creation slot. Fresh requests are bounded per account.
  if not exists (
    select 1 from public.cf_chat_generations
    where user_id = p_user_id and idempotency_key = p_idempotency_key
  ) then
    if (
      select count(*) from public.cf_chat_generations
      where user_id = p_user_id and created_at > now() - interval '1 minute'
    ) >= 12 then
      return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
    end if;

    if (
      select count(*) from public.cf_chat_generations
      where user_id = p_user_id
        and status in ('running','cancel_requested')
        and expires_at > now()
    ) >= 3 then
      return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ACTIVE_GENERATIONS');
    end if;
  end if;

  insert into public.cf_chat_generations(id, user_id, conversation_id, idempotency_key, provider)
  values (p_generation_id, p_user_id, p_conversation_id, p_idempotency_key, p_provider)
  on conflict (user_id, idempotency_key) do nothing;

  select * into v_generation
  from public.cf_chat_generations
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_CREATE_FAILED');
  end if;

  return jsonb_build_object(
    'ok', true,
    'generationId', v_generation.id,
    'status', v_generation.status,
    'lastEventSeq', v_generation.last_event_seq,
    'conversationId', v_generation.conversation_id,
    'provider', v_generation.provider,
    'existing', v_generation.id <> p_generation_id
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_ID_CONFLICT');
end;
$$;

create or replace function public.cf_claim_chat_generation(
  p_user_id uuid,
  p_generation_id uuid,
  p_conversation_id uuid,
  p_idempotency_key uuid,
  p_provider text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_generation public.cf_chat_generations%rowtype;
begin
  -- Exactly one request may cross the provider boundary for a generation.
  -- UPDATE takes a row lock and re-checks its predicate after concurrent writers,
  -- so a replay cannot start a second paid provider request.
  update public.cf_chat_generations
  set provider_started_at = now(),
      updated_at = now()
  where id = p_generation_id
    and user_id = p_user_id
    and conversation_id = p_conversation_id
    and idempotency_key = p_idempotency_key
    and provider = p_provider
    and status = 'running'
    and provider_started_at is null
    and expires_at > now()
  returning * into v_generation;

  if found then
    return jsonb_build_object('ok', true, 'claimed', true, 'status', v_generation.status);
  end if;

  select * into v_generation
  from public.cf_chat_generations
  where id = p_generation_id and user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_NOT_FOUND');
  end if;
  if v_generation.conversation_id <> p_conversation_id
     or v_generation.idempotency_key <> p_idempotency_key
     or v_generation.provider <> p_provider then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_REQUEST_MISMATCH');
  end if;
  if v_generation.status <> 'running' then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_NOT_RUNNING', 'status', v_generation.status);
  end if;
  if v_generation.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_EXPIRED');
  end if;
  if v_generation.provider_started_at is not null then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_ALREADY_STARTED');
  end if;

  return jsonb_build_object('ok', false, 'error', 'GENERATION_NOT_CLAIMABLE');
end;
$function$;

create or replace function public.cf_append_chat_generation_event(
  p_user_id uuid,
  p_generation_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 32768 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_EVENT_PAYLOAD');
  end if;

  update public.cf_chat_generations
  set last_event_seq = last_event_seq + 1, updated_at = now()
  where id = p_generation_id
    and user_id = p_user_id
    and status = 'running'
    and expires_at > now()
  returning last_event_seq into v_seq;

  if v_seq is null then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_NOT_RUNNING');
  end if;

  insert into public.cf_chat_generation_events(generation_id, user_id, seq, payload)
  values (p_generation_id, p_user_id, v_seq, p_payload);

  return jsonb_build_object('ok', true, 'seq', v_seq);
end;
$$;

create or replace function public.cf_request_chat_generation_cancel(
  p_user_id uuid,
  p_generation_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_generation public.cf_chat_generations%rowtype;
  v_seq bigint;
begin
  -- Cancellation becomes terminal immediately so a Stop request also works
  -- while a provider stream is still connecting or has not started yet.
  -- Any active stream pump observes this status and aborts its provider signal.
  update public.cf_chat_generations
  set status = 'cancelled',
      status_message = 'Cancelled by the account owner.',
      last_event_seq = last_event_seq + 1,
      updated_at = now()
  where id = p_generation_id
    and user_id = p_user_id
    and status in ('running','cancel_requested')
    and expires_at > now()
  returning * into v_generation;

  if found then
    v_seq := v_generation.last_event_seq;
    insert into public.cf_chat_generation_events(generation_id, user_id, seq, payload)
    values (
      p_generation_id,
      p_user_id,
      v_seq,
      jsonb_build_object(
        'status', 'cancelled',
        'cancelled', true,
        'done', true
      )
    );
    return jsonb_build_object('ok', true, 'status', v_generation.status);
  end if;

  select * into v_generation
  from public.cf_chat_generations
  where id = p_generation_id and user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_NOT_FOUND');
  end if;

  return jsonb_build_object('ok', true, 'status', v_generation.status);
end;
$$;

create or replace function public.cf_finish_chat_generation(
  p_user_id uuid,
  p_generation_id uuid,
  p_status text,
  p_status_message text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_generation public.cf_chat_generations%rowtype;
  v_final_status text;
  v_payload jsonb;
begin
  if p_status not in ('completed','failed','cancelled','expired') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_GENERATION_STATUS');
  end if;

  select * into v_generation
  from public.cf_chat_generations
  where id = p_generation_id and user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'GENERATION_NOT_FOUND');
  end if;

  if v_generation.status not in ('running','cancel_requested') then
    return jsonb_build_object('ok', true, 'status', v_generation.status, 'alreadyFinished', true);
  end if;

  v_final_status := case
    when v_generation.status = 'cancel_requested' then 'cancelled'
    else p_status
  end;

  update public.cf_chat_generations
  set status = v_final_status,
      status_message = left(coalesce(p_status_message, ''), 500),
      last_event_seq = last_event_seq + 1,
      updated_at = now()
  where id = p_generation_id and user_id = p_user_id
  returning * into v_generation;

  v_payload := case
    when v_final_status = 'completed' then jsonb_build_object('status', 'completed', 'done', true)
    when v_final_status = 'cancelled' then jsonb_build_object('status', 'cancelled', 'cancelled', true, 'done', true)
    when v_final_status = 'expired' then jsonb_build_object('status', 'expired', 'error', 'This generation expired before it could be recovered.', 'code', 'GENERATION_EXPIRED', 'done', true)
    else jsonb_build_object(
      'status', 'failed',
      'error', coalesce(nullif(left(p_status_message, 500), ''), 'This generation did not complete successfully.'),
      'code', 'GENERATION_FAILED',
      'done', true
    )
  end;

  insert into public.cf_chat_generation_events(generation_id, user_id, seq, payload)
  values (p_generation_id, p_user_id, v_generation.last_event_seq, v_payload);

  return jsonb_build_object('ok', true, 'status', v_final_status, 'lastEventSeq', v_generation.last_event_seq);
end;
$$;

revoke all on function public.cf_create_chat_generation(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cf_claim_chat_generation(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cf_append_chat_generation_event(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.cf_request_chat_generation_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cf_finish_chat_generation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cf_create_chat_generation(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.cf_claim_chat_generation(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.cf_append_chat_generation_event(uuid, uuid, jsonb) to service_role;
grant execute on function public.cf_request_chat_generation_cancel(uuid, uuid) to service_role;
grant execute on function public.cf_finish_chat_generation(uuid, uuid, text, text) to service_role;
