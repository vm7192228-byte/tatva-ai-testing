-- Align server-enforced monthly quotas with the finalized CodeForge AI plans.
insert into public.cf_plan_limits (plan_code, feature_code, monthly_limit, updated_at) values
  ('free','image_generation',2,now()),
  ('free','social_analysis',3,now()),
  ('free','social_edit',1,now()),
  ('free','video_generation',1,now()),
  ('starter_monthly','image_generation',10,now()),
  ('starter_monthly','video_generation',3,now()),
  ('pro_monthly','image_generation',30,now()),
  ('pro_monthly','video_generation',15,now()),
  ('pro_yearly','image_generation',30,now()),
  ('pro_yearly','video_generation',15,now())
on conflict (plan_code, feature_code) do update set monthly_limit=excluded.monthly_limit, updated_at=now();
