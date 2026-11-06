-- Avoid per-row auth.uid() evaluation in conversation RLS policies.
-- Keep the exact owner checks while allowing PostgreSQL to init-plan the auth lookup.
drop policy if exists "Users can read their own conversations" on public.conversations;
create policy "Users can read their own conversations"
  on public.conversations for select
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own conversations" on public.conversations;
create policy "Users can create their own conversations"
  on public.conversations for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own conversations" on public.conversations;
create policy "Users can update their own conversations"
  on public.conversations for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own conversations" on public.conversations;
create policy "Users can delete their own conversations"
  on public.conversations for delete
  using ((select auth.uid()) = user_id);
