import { describe, expect, it, vi } from "vitest";
import { claimKieVideoStatusPoll, KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS } from "../lib/video-job-polling.server";

const userId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-11-03T12:00:10.000Z");

describe("atomic KIE video status-poll cooldown", () => {
  it("keeps the cooldown longer than the provider status request timeout", () => {
    expect(KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS).toBe(15);
  });
  it("claims one owner-scoped poll slot and advances updated_at atomically", async () => {
    const restRequest = vi.fn().mockResolvedValue(Response.json([{ id: jobId }]));

    await expect(claimKieVideoStatusPoll(userId, jobId, restRequest, now)).resolves.toBe(true);

    expect(restRequest).toHaveBeenCalledOnce();
    const [path, init] = restRequest.mock.calls[0] as [string, RequestInit];
    expect(path).toContain("id=eq." + jobId);
    expect(path).toContain("user_id=eq." + userId);
    expect(path).toContain("provider=eq.kie");
    expect(path).toContain("status=in.(queued,in_progress)");
    expect(path).toContain("updated_at=lt.2026-11-03T11%3A59%3A55.000Z");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("prefer")).toBe("return=representation");
    expect(JSON.parse(String(init.body))).toEqual({ updated_at: "2026-11-03T12:00:10.000Z" });
  });

  it("returns false when another instance already claimed the poll window", async () => {
    const restRequest = vi.fn().mockResolvedValue(Response.json([]));

    await expect(claimKieVideoStatusPoll(userId, jobId, restRequest, now)).resolves.toBe(false);
  });

  it("rejects malformed owner or job IDs before querying the database", async () => {
    const restRequest = vi.fn();

    await expect(claimKieVideoStatusPoll("not-a-user", jobId, restRequest, now))
      .rejects.toThrow("INVALID_VIDEO_POLL_CLAIM");
    await expect(claimKieVideoStatusPoll(userId, "../job", restRequest, now))
      .rejects.toThrow("INVALID_VIDEO_POLL_CLAIM");
    expect(restRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the database cannot claim the poll window", async () => {
    const restRequest = vi.fn().mockResolvedValue(new Response("database unavailable", { status: 503 }));

    await expect(claimKieVideoStatusPoll(userId, jobId, restRequest, now))
      .rejects.toThrow("VIDEO_POLL_CLAIM_FAILED");
  });
});
