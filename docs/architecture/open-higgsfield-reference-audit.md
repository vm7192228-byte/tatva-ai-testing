# Open Higgsfield AI reference audit

Reference reviewed: https://github.com/Autom8AI/Open-Higgsfield-AI

## What is useful

- The repository separates image, video, lip-sync and cinema studios into focused components.
- Its model catalog describes model-specific inputs and controls rather than forcing every model into one generic form.
- The studio UX demonstrates text-to-image versus image-to-image, text-to-video versus image-to-video, reference-image selection, aspect-ratio/resolution controls, and generation history.
- The current source includes a KIE API client in `packages/studio/src/kie.js` with task submission and status lookup.

## Important implementation caveats

- The README describes Muapi, while the inspected current source uses `https://api.kie.ai` and a KIE Bearer token. Treat the README's provider description as stale until verified against the exact deployed revision.
- The standalone shell stores the provider key in browser `localStorage` and passes it into studio components. CodeForge must not copy this credential pattern.
- The KIE client polls from the browser and can loop for up to 900 attempts at two-second intervals for video. CodeForge should not copy this long-running request pattern into a Vercel request.
- The model catalog is large and provider-specific. Do not import the catalog wholesale or promise every listed model is currently available, correctly priced, or supported by our account.

## Existing CodeForge media architecture observed on the feature branch

- Image generation is routed through the server-side FreeLLMAPI OpenAI-compatible `/images/generations` endpoint.
- Image requests require an authenticated CodeForge session, same-origin request, rate-limit check, a database quota reservation, provider response validation, and quota finalization.
- The shared chat media route and the manual media route currently return `LONG_FORM_VIDEO_PIPELINE_NOT_READY` for video requests. The retired WaveSpeed route also reports that the long-form pipeline is disabled.
- The existing video-job table and quota RPC are currently constrained to the WaveSpeed provider. They are not yet a ready-made KIE job store.
- Cloudflare image and Pollinations video helpers exist in the media module but are not the active generation path.

## Safe integration direction

1. Keep provider credentials server-side only (for example, a Vercel server environment variable); never put them in browser storage, HTML, logs, or client bundles.
2. Add a provider adapter behind the existing CodeForge media API rather than importing the reference app's shell or direct browser client.
3. Use asynchronous task creation and short, authenticated status checks. Persist provider, task ID, owner ID, status, and output metadata; enforce owner checks on every status/result/cancel request.
4. Extend quota reservation and idempotency before enabling a new provider. Failed jobs must release reservations; successful jobs must commit them; ambiguous provider outcomes must not trigger automatic duplicate generation.
5. Add provider contract tests for authentication, request validation, status transitions, output URL validation, timeout behavior, duplicate submission, and user/job isolation.
6. Only enable the provider after its API key, model access, cost limits, and staging end-to-end tests are configured.

## KIE adapter implementation status (feature branch)

- Added `src/lib/kie-video-provider.server.ts` with server-only Bearer authentication, a fixed HTTPS KIE API origin, bounded request timeouts, model-input key validation, task creation, one-shot task status lookup, normalized task states, and HTTPS-only result URL extraction.
- Added `src/test/kie-video-provider.test.ts` for missing credentials, task submission, invalid input, queued/running/succeeded states, malformed task IDs, and provider rate-limit errors.
- Added both files to the feature CI lint list.
- The adapter accepts model-specific input fields because KIE model schemas differ (for example, the Wan 2.7 text-to-video page uses `ratio`, while other model pages may use different fields).
- The adapter is intentionally not imported by the media route. It does not create database jobs, reserve or finalize CodeForge quota, expose a status endpoint, or enable KIE in production. No KIE API key is required for this isolated stage.

## KIE async job and quota integration (feature branch)

- Added an additive migration for per-user idempotency, request fingerprints, provider model metadata, and the service-role-only `cf_reserve_kie_video_job` RPC.
- The reservation RPC serializes by user, returns the existing job for a matching idempotency key + request fingerprint, rejects key reuse with a different request, and applies the existing monthly video-credit plan limits.
- Extended `/api/video`: POST creates a KIE task after reserving a job; GET checks an owned KIE job once and persists queued/running/succeeded/failed state. Existing WaveSpeed GET polling remains supported.
- Initial KIE route is deliberately constrained to the documented Wan 2.7 text-to-video model by default, 5-second duration, and 16:9 / 9:16 aspect ratios. The model can be changed only through the server-side `KIE_VIDEO_MODEL` environment variable.
- Ambiguous provider timeouts keep the reservation in `reserved` state and do not resubmit automatically; this avoids accidental duplicate paid provider tasks. Failed provider jobs are excluded by the existing quota ledger.
- This is feature-branch code only. Apply the migration to staging and run authenticated end-to-end checks before configuring any KIE key or enabling it for users.

## Staging verification

- Migration `20261103050000_add_kie_video_jobs.sql` was applied to the staging project only; Supabase recorded it as `20261103050340_add_kie_video_jobs`.
- Verified the four additive columns, unique user/idempotency index, and RPC presence.
- Verified `anon` and `authenticated` cannot execute the reservation RPC or read `cf_video_jobs`; `service_role` can execute the RPC. RLS remains enabled.
- The staging RPC rejects an invalid request as expected. No test user, video job, or provider call was created.
- Supabase security advisors returned existing informational `rls_enabled_no_policy` findings for service-role-only tables; no new public execution grant was detected for the KIE RPC.

## Video Studio UI integration (feature branch)

- Replaced the retired Wan placeholder modal with a KIE text-to-video studio entry point in the existing CodeForge UI.
- Added a 5-second prompt form, supported aspect ratios (9:16 and 16:9), authenticated same-origin POST, per-request idempotency-key reuse for ambiguous client/network retries, one-shot status requests with a bounded automatic polling window, manual status refresh, and HTTPS-only video preview/open link.
- The studio stops polling when the modal is closed or replaced. It loads the latest 12 KIE jobs from a user-scoped history endpoint; job IDs are not persisted to browser storage. Users can refresh the list, check active jobs, and open completed videos.
- The sidebar video tool and the existing quick action now open the studio. The image composer behavior is unchanged.
- Added the existing studio stylesheet to the route head and scoped styles for the KIE generation form/status/preview.
- This is a feature-branch integration only. The provider remains disabled until the server-side Preview KIE key is configured; no provider call or real video generation has been tested yet.

## Claude ZIP review: provider failover and routing-intent isolation

- The useful backend change was reviewed and adapted rather than copied wholesale.
- Smart text chat can try the configured FreeLLMAPI stream first and the existing Gemini model chain only if no answer text has reached the user. Once text is emitted, it never switches models mid-answer.
- Automatic Gemini fallback is limited to non-voice Smart requests without inline media attachments. Explicit provider selection and the existing voice path remain unchanged. No additional paid Cloudflare or Pollinations fallback is silently enabled.
- Failover validates SSE responses, bounds the number of attempts, cancels failed streams, preserves the final provider error, and has tests for aborts, malformed upstream responses, empty failures, and no mixed-model output.
- Tool-intent detection now uses the user's typed message separately from extracted attachment text. Fenced code and appended text-file content are excluded from YouTube/Meta/web-search routing decisions, preventing a README or pasted code sample from triggering connector calls.

## Current decision

Use Open Higgsfield AI as a reference for studio UX and model-capability metadata. Do not copy its browser-key storage or long polling. Do not enable a new paid media provider or change production media routing as part of this reference review.
