-- Owner-scoped persistent conversations.
-- This migration version/name already exists on the connected CodeForge database;
-- the file was missing from the repository and is restored here for reproducible staging.

create table if not exists public.conversations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat'
    constraint conversations_title_length check (char_length(title) >= 1 and char_length(title) <= 160),
  messages jsonb not null default '[]'::jsonb
    constraint conversations_messages_array check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

alter table public.conversations enable row level security;

revoke all on public.conversations from anon;
grant select, insert, update, delete on public.conversations to authenticated;
grant all on public.conversations to service_role;

create policy "Users can create their own conversations"
  on public.conversations for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can read their own conversations"
  on public.conversations for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can update their own conversations"
  on public.conversations for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own conversations"
  on public.conversations for delete
  to authenticated
  using ((select auth.uid()) = user_id);
