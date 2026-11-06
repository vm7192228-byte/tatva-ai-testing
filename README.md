# CodeForge AI Workbench

CodeForge AI is a light-first, chat-first workspace with a separate Forge Burst logo, an optional dark theme, a compact composer, and a `+` menu for GitHub, YouTube, Instagram, and Facebook setup.

Live preview: https://codeforge-ai-workbench.lovable.app

## Frontend

- Main screen markup: `src/lib/codeforge-markup.ts`
- Route shell: `src/routes/index.tsx`
- UI script: `public/codeforge/app.js`
- UI styles: `public/codeforge/styles.css`
- Logo: `public/tatv/tatv-mark.svg` (served at `/tatv/tatv-mark.svg`)

The sidebar can collapse on desktop; on smaller screens it opens as a drawer. App connections live under the chat composer’s `+` menu instead of taking up the home screen.

## Backend: Tatv Smart provider routing

The server-side chat handler is `src/lib/chat-api.server.ts`, called by `src/server.ts` before the app router. Provider credentials and verified session tokens stay on the server.

- `GET /api/chat` returns provider-readiness flags without exposing secret values.
- `POST /api/chat` applies the same Smart routing order to the owner, signed-in users and guests: **FreeLLMAPI first, eligible private CodeForge gateways second, then configured direct providers**.
- FreeLLMAPI is the shared first hop for Tatv Smart. Any upstream credential, model, billing, quota, rate-limit or service failure before answer output moves to the next eligible route.
- Private CodeForge gateways are used only when a signed-in user's verified Supabase access JWT is available. The gateway never receives the shared FreeLLMAPI key or an administrator credential.
- After the configured private gateways, Smart can try server-side OpenAI, Anthropic, DeepSeek, xAI, Qwen, Cloudflare Workers AI and Pollinations credentials. Guest traffic skips the authenticated-only private gateway tier and can continue to configured direct providers.
- Provider/API configuration and upstream errors are kept out of user-facing messages and recorded only as normalized server diagnostics. User authentication/access denials, bans, suspension, user-level quotas/permissions, and content-policy decisions remain terminal. Failover never replays a request after answer text or tool side effects begin.
- Text chat remains free on every plan. Existing server-side subscription/quota reservations for image generation, video generation and file analysis remain enforced independently of the selected chat provider.
- Gemini is disabled for this learner-facing release. Inline image, audio and video analysis remain unavailable until an approved multimodal provider is configured.
- API keys and session tokens are never embedded in frontend JavaScript. Browser sessions use HttpOnly cookies.

Configure these values in the hosting provider's **server-side environment** panel:

- `FREELLMAPI_BASE_URL`, `FREELLMAPI_API_KEY`, and `FREELLMAPI_MODEL` — shared first-hop settings for Tatv Smart. Keep the unified key server-side only.
- `CODEFORGE_GATEWAY_URL` — primary private gateway HTTPS URL. The Workbench appends `/v1` when needed.
- `CODEFORGE_GATEWAY_MODEL` — optional primary model/routing profile; defaults to `auto`.
- `CODEFORGE_GATEWAY_FALLBACK_URL` and `CODEFORGE_GATEWAY_FALLBACK_MODEL` — optional second private gateway.
- `CODEFORGE_GATEWAY_FALLBACK_2_URL` and `CODEFORGE_GATEWAY_FALLBACK_2_MODEL` — optional third private gateway.
- `CODEFORGE_GATEWAY_FALLBACK_3_URL` and `CODEFORGE_GATEWAY_FALLBACK_3_MODEL` — optional fourth private gateway.
- Optional final-tier keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `QWEN_BASE_URL` / `QWEN_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`, and `POLLINATIONS_API_KEY`.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or the supported publishable-key alias) — Workbench Auth configuration. Each private gateway's JWT verifier must use this same project's trusted issuer/JWKS.
- `SUPABASE_SERVICE_ROLE_KEY` (or the supported secret-key alias) — server-only database operations, usage limits, shared rate limits and saved conversations. Never expose this key in browser code.

For private-gateway failover, configure only independently operated instances. Do not repeat the same URL in multiple slots. Each backup needs a healthy service, matching user-JWT trust, eligible provider credentials and at least one enabled chat model.

## App connections

GitHub, YouTube, Instagram, and Facebook setup screens are UI scaffolding only. OAuth is **not active yet**. Each provider still needs a registered developer app, client ID, approved scopes, final deployment URL, and exact OAuth callback URL; client secrets must be stored server-side. YouTube and Meta permissions may need provider review.

## Cloudflare Workers testing deployment

The current self-hosted Nitro target is intended for Cloudflare Workers when `VERCEL=1` is not set. See [the Cloudflare Workers testing deployment guide](docs/CLOUDFLARE_WORKERS_DEPLOYMENT.md) for build commands, server-side variables, and the text-chat verification order. Keep this testing Worker separate from the existing production Workbench.

## Run and check

```sh
npm install
npm run dev
npm run build
npm run lint
```

## Current scope and production checklist

Authentication, editable profile settings, saved per-user conversations, database-backed usage controls, and a shared rate-limit ledger are implemented in the current codebase. Tatv Smart requires sign-in and a configured private gateway; guest workspace browsing is separate from authenticated AI inference. Integration readiness differs by provider and must be checked against each registered OAuth application's credentials, scopes, callback URL, and review status. Before a public launch, verify that the production gateway trusts the Workbench Supabase issuer, at least one eligible provider/model is enabled, an independent backup is available, and live chat/voice/browser flows pass on the actual Production deployment. Also complete monitoring, provider-side spending limits, operational backups, privacy/legal review, and the final subscription/payment smoke tests.

## File-aware coding and document workspace

The chat composer accepts ZIP project archives, source files, modern Office documents, PDFs, and images.

- ZIP project archives are inspected in the browser. CodeForge reads a bounded set of text/source files and a project tree, then sends that text context to the selected chat provider. It does not upload or execute archive scripts.
- The ZIP reader validates the central directory, entry paths, compression sizes, and CRC checks. It rejects encrypted, malformed, path-traversal, and symbolic-link entries. It skips dependency/build folders, common lockfiles, binary assets, and likely secret files such as `.env`, private keys, and credential files; common hard-coded API-key, token, password, and PEM-key patterns are redacted from text context. Safe templates such as `.env.example` remain readable with literal values redacted.
- ZIP input is limited to 8 MB, with up to 24 readable source files and a bounded text context. For best results, exclude `node_modules`, `.git`, build output, generated bundles, and large media before creating the archive.
- `.docx`, `.xlsx`, and `.pptx` are read from their text-bearing Office XML parts. Legacy binary `.doc`, `.xls`, and `.ppt` files should be saved as modern Office files or PDF first.
- Images, PDFs, audio, and video continue through the existing Gemini multimodal path when Gemini is configured. The inline media payload is kept under the server's existing size guard.
- Explicit requests to create or export a project ZIP use a structured file bundle response. CodeForge validates relative paths, blocks secret-file paths and duplicate entries, and then creates a downloadable ZIP in the browser. The model does not run generated code or claim that it has been tested.
- Screenshot questions that ask for next steps or troubleshooting can trigger a small Tavily lookup when a screenshot is attached and `TAVILY_API_KEY` is configured. Recent conversation context is included when it helps identify the service being configured. General image understanding does not require a web search.
- Extracted project source stays in the active browser chat so follow-up coding questions can refer to the same files. Saved conversation records intentionally omit attachment contents; uploaded source is not copied into persistent chat history.

All archive content, source comments, README text, and external search results are treated as untrusted input. The model is instructed to inspect code rather than execute it or obey instructions embedded inside uploaded files. File size and provider usage limits remain in place to protect stability and avoid unexpected provider costs.

## Cashfree subscription checkout (Sandbox first)

Subscriptions use Cashfree hosted checkout. The server creates orders with the Cashfree Payments API, verifies successful payments with the server-side payments endpoint, and accepts signed webhooks. Test credentials are stored only in Vercel server-side environment variables.

- `CASHFREE_APP_ID` — Cashfree TEST App ID.
- `CASHFREE_SECRET_KEY` — Cashfree TEST Secret Key. Keep it server-side and never add it to frontend code.
- `CASHFREE_ENVIRONMENT` — optional; defaults to `sandbox`. Do not set to `production` while using TEST credentials.
- Subscription checkout requires the customer to enter a 10-digit Indian mobile number and uses the signed-in account email.
- Configure the Cashfree webhook URL as `https://codeforge-ai-workbench.vercel.app/api/billing/webhook`, select payment success/failure events, and keep the same test app credentials in Vercel.
- After changing Vercel environment values, redeploy the Workbench to load them.

## KIE video generation (subscription-gated)

New Video Studio jobs use KIE's asynchronous Market task API. The server verifies the signed-in Supabase user and reserves the user's monthly video allowance in the existing database ledger before submitting a single provider task. The browser never receives provider credentials.

- Provider/model: KIE `wan/2-7-text-to-video`; current route accepts 5-second text-to-video jobs in 9:16 or 16:9.
- Server-only environment values: `KIE_API_KEY` is required; the separate `KIE_WEBHOOK_HMAC_KEY` from KIE AI Settings is optional but recommended for callback-based recovery. Do not use the API bearer key as the webhook HMAC key, and never expose either value in browser code.
- When `KIE_WEBHOOK_HMAC_KEY` is configured and HMAC verification is enabled in KIE settings, CodeForge registers a callback, verifies `X-Webhook-Timestamp` and `X-Webhook-Signature`, binds the callback URL to an expiring job-specific token, and confirms the task through KIE's authenticated task-details API before updating the database. Without the optional webhook key, normal KIE task creation and status polling continue, but an already-created task cannot be automatically recovered if its initial task-ID database write fails.
- Keep `PUBLIC_APP_URL` set to the public HTTPS application origin when the request origin is not the canonical CodeForge domain. Otherwise the callback URL is built from the HTTPS request origin.
- The migration `supabase/migrations/20261103050340_add_kie_video_jobs.sql` extends the existing service-role-only video ledger with KIE idempotency and task metadata. Apply it only to the Supabase project that already contains `cf_subscriptions`; validate it in staging before production.
- Legacy WaveSpeed jobs remain readable through the existing status route, but new Video Studio submissions use KIE.
- A CodeForge subscription and KIE provider credits are separate. Verify current KIE account balance and model pricing before enabling public video generation.

