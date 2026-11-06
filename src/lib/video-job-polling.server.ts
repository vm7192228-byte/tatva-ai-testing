const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS = 15;
const MINIMUM_POLL_INTERVAL_MS = KIE_VIDEO_STATUS_POLL_COOLDOWN_SECONDS * 1_000;

type RestRequest = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Atomically claims a short status-poll window for one owner-scoped KIE job.
 * The updated_at predicate is evaluated by PostgREST in the database, so
 * concurrent Vercel/Workers instances cannot all poll the same task at once.
 */
export async function claimKieVideoStatusPoll(
  userId: string,
  jobId: string,
  restRequest: RestRequest,
  now = Date.now(),
): Promise<boolean> {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(jobId) || !Number.isFinite(now)) {
    throw new Error("INVALID_VIDEO_POLL_CLAIM");
  }

  const checkedAt = new Date(now);
  const cutoff = new Date(now - MINIMUM_POLL_INTERVAL_MS).toISOString();
  const query = "cf_video_jobs?id=eq." + encodeURIComponent(jobId)
    + "&user_id=eq." + encodeURIComponent(userId)
    + "&provider=eq.kie"
    + "&status=in.(queued,in_progress)"
    + "&updated_at=lt." + encodeURIComponent(cutoff)
    + "&select=id";
  const response = await restRequest(query, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ updated_at: checkedAt.toISOString() }),
  });
  if (!response.ok) throw new Error("VIDEO_POLL_CLAIM_FAILED");

  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("VIDEO_POLL_CLAIM_INVALID"); }
  return Array.isArray(payload) && payload.length === 1 &&
    Boolean(payload[0] && typeof payload[0] === "object" &&
      (payload[0] as Record<string, unknown>)["id"] === jobId);
}
