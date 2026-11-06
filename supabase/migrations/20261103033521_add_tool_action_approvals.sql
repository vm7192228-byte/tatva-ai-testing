-- Durable, owner-scoped approval records for AI-proposed social actions.
-- All access is server-only; clients never receive direct table privileges.

create table if not exists public.cf_tool_action_approvals (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_name text not null check (tool_name in (
    'youtube_update_video',
    'youtube_delete_video',
    'facebook_publish_post',
    'instagram_publish_post'
  )),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16000),
  idempotency_key text not null
    check (length(idempotency_key) between 1 and 220),
  status text not null default 'pending'
    check (status in ('pending','executing','executed','rejected','failed','expired','uncertain')),
  result jsonb
    check (result is null or octet_length(result::text) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  decided_at timestamptz,
  finished_at timestamptz,
  unique (user_id, idempotency_key),
  constraint cf_tool_action_approval_expiry_after_creation
    check (expires_at > created_at)
);

create index if not exists cf_tool_action_approvals_user_recent_idx
  on public.cf_tool_action_approvals(user_id, created_at desc);

create index if not exists cf_tool_action_approvals_pending_expiry_idx
  on public.cf_tool_action_approvals(expires_at)
  where status = 'pending';

alter table public.cf_tool_action_approvals enable row level security;
revoke all on public.cf_tool_action_approvals from anon, authenticated;
grant select, insert, update, delete on public.cf_tool_action_approvals to service_role;
