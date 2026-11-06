-- Set a strict monthly image cap for every plan and disable video generation.
-- This is enforced by cf_consume_usage_quota on the server, not just the UI.
insert into public.cf_plan_limits (plan_code, feature_code, monthly_limit) values
  ('free', 'image_generation', 3),
  ('starter_monthly', 'image_generation', 3),
  ('pro_monthly', 'image_generation', 3),
  ('pro_yearly', 'image_generation', 3),
  ('free', 'video_generation', 0),
  ('starter_monthly', 'video_generation', 0),
  ('pro_monthly', 'video_generation', 0),
  ('pro_yearly', 'video_generation', 0)
on conflict (plan_code, feature_code) do update
set monthly_limit = excluded.monthly_limit, updated_at = now();
