import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tatv subscription limit migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20261105170900_align_tatv_plan_limits.sql"),
    "utf8",
  );

  it("keeps text chat included on all plans while Gateway fair-use controls remain independent", () => {
    expect(migration).toContain("monthly_limit = -1");
    expect(migration).toContain("feature_code = 'super_chat'");
    expect(migration).toContain("('free', 'pro_monthly', 'pro_yearly', 'creator_monthly')");
  });

  it("removes video generation from Free and gives paid plans 3 / 24 credits", () => {
    expect(migration).toContain("WHEN 'free' THEN 0");
    expect(migration).toContain("WHEN 'starter_monthly' THEN 3");
    expect(migration).toContain("WHEN 'pro_monthly' THEN 3");
    expect(migration).toContain("WHEN 'pro_yearly' THEN 3");
    expect(migration).toContain("WHEN 'creator_monthly' THEN 24");
    expect(migration).toContain("public.cf_reserve_kie_video_job");
    expect(migration).toContain("feature_code = 'video_generation'");
    expect(migration).toContain("monthly_limit = 3");
    expect(migration).toContain("monthly_limit = 24");
  });

  it("caps file analysis at 3 / 20 / 60 per month", () => {
    expect(migration).toContain("monthly_limit = 3");
    expect(migration).toContain("monthly_limit = 20");
    expect(migration).toContain("monthly_limit = 60");
    expect(migration).toContain("feature_code = 'file_analysis'");
  });

  it("caps image generation at 2 / 20 / 60 per month", () => {
    expect(migration).toContain("monthly_limit = 2");
    expect(migration).toContain("feature_code = 'image_generation'");
  });

  it("keeps video reservation idempotent and cost-weighted", () => {
    expect(migration).toContain("v_cost := CASE WHEN v_plan_code = 'creator_monthly' THEN 2 ELSE 1 END;");
    expect(migration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("p_request_fingerprint !~ '^[0-9a-f]{64}$'");
  });
});
