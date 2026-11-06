-- CodeForge Max monthly quotas. -1 means unlimited in cf_consume_usage_quota.
insert into public.cf_plan_limits (plan_code, feature_code, monthly_limit, updated_at) values
  ('creator_monthly','image_generation',-1,now()),
  ('creator_monthly','video_generation',100,now()),
  ('creator_monthly','social_analysis',-1,now()),
  ('creator_monthly','social_edit',-1,now()),
  ('creator_monthly','file_analysis',-1,now()),
  ('creator_monthly','super_chat',-1,now())
on conflict (plan_code, feature_code) do update set monthly_limit=excluded.monthly_limit, updated_at=now();
