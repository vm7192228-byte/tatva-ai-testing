# Dhwani AI testing workspace — Cloudflare Workers testing deployment

This guide is for the separate `tatva-ai-testing` Worker only. It does not change or deploy the existing production Workbench.

## Build target

The project is a TanStack Start + Vite app using the Nitro Cloudflare Workers module preset. The GitHub Actions CI build has already generated the Cloudflare Worker output successfully (`.output/server/wrangler.json`).

For the first testing deployment, connect the GitHub branch `import/workbench-stage1` directly to a **new, separate Worker**. Keep this Worker isolated from the production Workbench Worker.

## Cloudflare Workers Builds settings

Use these values for the new testing Worker:

- Git repository: `vm7192228-byte/tatva-ai-testing`
- Branch: `import/workbench-stage1`
- Root directory: `/`
- Install command (if shown): `bun install --frozen-lockfile`
- Build command: `bun run build`
- Deploy command: `bunx nitro deploy --prebuilt`

Do not set `VERCEL=1` and do not add a Vercel Nitro preset in the Cloudflare build environment. Nitro's deploy command deploys the existing Cloudflare build output; do not run the generic Wrangler auto-configuration flow against this already configured Nitro build.

For a local preview of the built app, use:

```sh
bun run preview
```

The deployment command is based on the Cloudflare build output produced by the repository's own CI. Do not change the Worker entry path or add a hand-written Wrangler configuration unless a later Cloudflare build log demonstrates that it is necessary.

## First variables for text-chat testing

Add these to the **testing Worker only**, in Cloudflare Dashboard → Workers & Pages → the testing Worker → Settings → Variables and Secrets:

| Name | Cloudflare setting | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Variable | The same Supabase project used by Workbench sign-in and the gateway JWT verifier |
| `SUPABASE_ANON_KEY` | Variable | The matching Supabase anon/publishable key used by Workbench Auth routes |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Server-only database operations for durable conversations and usage accounting |
| `FREELLMAPI_BASE_URL` | Variable | Shared first-hop URL for Dhwani Smart (HTTPS, server-side only) |
| `FREELLMAPI_API_KEY` | Secret | Server-only unified key; never exposed to the browser or forwarded to private gateways |
| `FREELLMAPI_MODEL` | Variable (optional) | Model hint for the FreeLLMAPI first hop; defaults to `auto` |
| `CODEFORGE_GATEWAY_URL` | Variable | HTTPS base URL of the private multi-user CodeForge/Dhwani gateway |
| `CODEFORGE_GATEWAY_MODEL` | Variable (optional) | Use `auto` unless the gateway owner explicitly configured a reviewed model ID |

Set `SUPABASE_SERVICE_ROLE_KEY` as a Secret, never a plain-text variable. Never add Supabase keys, provider keys, or secrets to `VITE_*` client variables. The service-role key must remain server-only.

The Gateway must independently trust the same Supabase Auth issuer/JWKS and have at least one enabled **chat** model with an active provider credential. `NO_PROVIDER_MODEL` is emitted by the Gateway when its chat model catalog has no eligible model; adding a Worker variable does not create or enable a Gateway model.

Do not put a gateway administrator token or upstream provider API key in the Workbench Worker. Keep upstream provider credentials in the Gateway's own server-side secret store. Image/video variables and failover are intentionally out of this first text-chat deployment checklist.

## Verification order

1. Open the testing Worker URL and confirm the logo appears in the sidebar and top bar.
2. Sign in with a testing account and confirm the session remains active after refresh.
3. Send a short plain-text message using Dhwani Smart. Confirm that the FreeLLMAPI first hop is attempted before authenticated private gateways and configured direct-provider fallback.
4. If the response still says `NO_PROVIDER_MODEL`, inspect the Gateway model catalogue and provider credential status. Do not change login code based on that Gateway response.
5. Only after Smart text chat works, test other independent features.

## CI validation status

The Cloudflare Nitro build and the browser private-alpha E2E workflow have succeeded on the current PR commit. The general CI workflow currently has two failing unit-test expectations (one stale KIE request expectation and one Tavily mock expectation) plus one lint error in a test file. These checks should be resolved before considering the PR fully green; they do not change the Workbench chat or logo code.
