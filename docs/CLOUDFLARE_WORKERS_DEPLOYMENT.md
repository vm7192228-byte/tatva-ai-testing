# Tatv AI Workbench — Cloudflare Workers testing deployment

This guide is for the separate `tatva-ai-testing` Worker only. It does not change or deploy the existing production Workbench.

## Build target

The project is a TanStack Start + Vite app. Its current Vite wrapper enables the Nitro build adapter and documents Cloudflare as the default self-hosted target; `VERCEL=1` is the only branch that explicitly changes the Nitro preset to Vercel. Keep that distinction when building this testing repository.

The Nitro Cloudflare Workers provider uses the `cloudflare_module` output. After building, deploy with Wrangler:

```sh
bun install --frozen-lockfile
bun run build
bunx wrangler deploy
```

For a local Worker-runtime preview after the build:

```sh
bunx wrangler dev
```

Do not add a Vercel preset or set `VERCEL=1` in the Cloudflare build environment. Do not run this testing build against the production Worker name.

## Cloudflare Workers Builds

When connecting this GitHub repository in Cloudflare Workers Builds, use the testing branch first (not the production Workbench repository):

- Root directory: `/`
- Build command: `bun run build`
- Deploy command: `bunx wrangler deploy`
- Preview command: `bunx wrangler dev`

The repository includes `bun.lock`; use Bun for a lockfile-consistent install. If the Cloudflare build setup exposes a separate install-command field, use `bun install --frozen-lockfile`.

The first build must be checked in the Cloudflare build log. If Nitro does not generate a Wrangler-compatible Worker config for the locked dependency set, stop and inspect the build output before adding a hand-written `wrangler.toml`; do not guess the generated Worker entry path.

## First variables for text-chat testing

Add these to the **testing Worker only**, in the Cloudflare dashboard's Worker settings under Variables and Secrets:

| Name | Cloudflare setting | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Variable | The same Supabase project used by the Workbench sign-in and the gateway JWT verifier |
| `SUPABASE_ANON_KEY` | Variable | The matching Supabase anon/publishable key used by the Workbench Auth routes |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Server-only database operations for durable conversations and usage accounting |
| `CODEFORGE_GATEWAY_URL` | Variable | HTTPS base URL of the private multi-user CodeForge/Tatv gateway; use its actual deployed URL |
| `CODEFORGE_GATEWAY_MODEL` | Variable (optional) | `auto` unless the gateway owner has explicitly configured a reviewed model ID |

Set `SUPABASE_SERVICE_ROLE_KEY` as a Secret, never a plain-text variable, and never add any Supabase or provider key to `VITE_*` client variables. The service-role key must remain server-only.

The Gateway must independently trust the same Supabase Auth issuer/JWKS and have at least one enabled **chat** model with an active provider credential. `NO_PROVIDER_MODEL` is emitted by the Gateway when its chat model catalog has no eligible model; adding a Worker variable does not create or enable a Gateway model.

Do not put a gateway administrator token or upstream provider API key in the Workbench Worker. Keep upstream provider credentials in the Gateway's own server-side secret store. Image/video variables and failover are intentionally out of this first text-chat deployment checklist.

## Verification order

1. Open the testing Worker URL and confirm the logo appears in the sidebar and top bar.
2. Sign in with a testing account and confirm the session remains active after refresh.
3. Send a short plain-text message using Tatv Smart.
4. If the response still says `NO_PROVIDER_MODEL`, inspect the Gateway model catalogue and provider credential status. Do not change login code based on that Gateway response.
5. Only after Smart text chat works, test other independent features.
