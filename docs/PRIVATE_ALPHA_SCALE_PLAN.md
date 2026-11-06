# Tattv AI private alpha and staged growth gates

This plan treats registered accounts and simultaneous active requests as separate capacity measurements. A product with 50 accounts may generate only a few concurrent requests, while a smaller test group can create a burst of simultaneous long streams. Increase access only after the measured service envelope supports the next stage.

## Gateway topology

- The primary Smart route is the privately operated CodeForge FreeLLM gateway. It verifies each signed-in user's Supabase JWT and applies independent per-user request/token and provider limits.
- The optional secondary route is a separately deployed private CodeForge gateway instance. It must verify the same trusted Auth issuer for that environment and have an independently available provider catalog.
- The public FreeLLMAPI Unified service is excluded from Tattv multi-user traffic because its upstream repository describes it as a single-user personal-experimentation proxy, not a production multi-tenant API.
- Workbench reserves product usage in its own database before sending a request. Each private gateway applies its own second-level user/provider budget. These limits are safeguards, not a way to create or combine upstream free quotas.
- Failover is pre-answer only. Do not replay after answer text, tool execution, or an approval side effect begins. Retry only explicitly classified transient/network/rate-limit failures. Credential, permission, billing, model, malformed-request and provider-policy errors must remain visible.
- Guests do not use the private user-JWT gateway. Guest Smart chat stays disabled until a separately approved guest identity/quota design exists; never send a shared admin token or a personal FreeLLM key to represent a guest.

## Stage gates

| Stage | Entry requirement | Observe before expanding |
|---|---|---|
| 3–4 private alpha testers | A current protected Preview, isolated Workbench staging DB, real sign-in/session recovery, actual signed-in Smart request through the private primary, independent fallback disabled until JWT/model/DB checks pass, upload and voice round-trips | Per-user isolation, quota reservation/release, no cross-account data, no duplicate tool or payment actions, first-token latency, provider failure/fallback reasons |
| 10 testers | First alpha cohort completes a full test cycle with no unresolved P0/P1 defects; dashboard and alerts are available | Peak concurrent streams, 429/5xx rate, p50/p95 first-token and completion times, gateway cold-start incidence, token spend per active user |
| 20 testers | 10-user cohort is stable over multiple days; backup gateway passes authenticated live chat with quotas enforced | 5–10 concurrent long streams under a controlled test; database pool utilization, timeouts, memory/CPU, provider mix and budget burn |
| 30–50 testers | 20-user cohort remains stable; Render service is always-on or has a measured cold-start policy; database backups and restore are verified | Load test at least 2x the expected peak concurrency, sustained stream handling, upload throughput, quota contention, failover recovery and alert response |
| Public business launch | Terms/permissions for every upstream provider are verified for the actual audience and commercial use; payment/webhook recovery and data deletion are tested; incident/rollback runbook exists | Forecast-based load and spend limits, provider-specific quotas, backup/restore drill, security review, abuse controls, support process and production rollback |

These are rollout checkpoints, not claims that the current free-tier Render services or upstream API accounts have been load-tested at these levels. Set exact concurrency and budget thresholds from measured results before each stage.

## Required operational measurements

Record request counts by provider and result category, retry/failover counts, model ID, token usage when supplied by the provider, first-token and completion latency, 429/5xx/timeout rate, reservation commit/release/expiry outcomes, per-user quota exhaustion, and gateway cold starts. Do not log raw prompts, uploaded content, cookies, JWTs, provider keys or raw payment details. Prefer a non-reversible user pseudonym for correlation.

Alert on repeated provider authentication/permission failures, unexpected increases in fallback rate, sustained 5xx/429 responses, reservation-finalization failures, unusual token-spend growth, database-pool saturation, and missing backups. A provider being configured or a health endpoint returning 200 does not prove that its model catalog is enabled or a real inference request succeeds.

## Commercial capacity and quota boundaries

Do not advertise the two private gateway quotas as one guaranteed pooled token balance. Each provider account controls its own access, rate limits, monthly caps, model availability, commercial permissions and changes. The private gateway controls routing, per-user budgets and provider-key management; it does not produce new inference credits. Check the license and upstream terms for the each upstream provider and any personal-experimentation gateway kept outside Tattv traffic and every configured provider before inviting a wider audience or launching commercially.

The private gateway is currently a free-tier Render service with one instance and its prior logs included 503 responses for chat completions. It must not be enabled as a production backup until its trusted Supabase issuer/JWKS, persistent PostgreSQL connection, encrypted-key configuration, allowed-origin/host lists, enabled chat model and a successful authenticated streaming request are verified. Preview and Production may use different Supabase projects; do not send a Preview JWT to a gateway that trusts only the Production issuer (or vice versa).

## Rollback

If a gateway starts failing, remove its server-side URL/key from the target environment or disable that provider in the gateway. Do not remove the healthy primary route to test a backup. Keep Preview variables branch-scoped; never use Production or Academy database credentials in Preview. Revert the feature-branch commit if a routing change causes duplicate work, unsafe retries, quota bypass or cross-user data access.
