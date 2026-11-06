# Tatv AI Testing — Stage 1

## Scope

This package imports the complete current Workbench source into the new `tatva-ai-testing` testing repository. The first review is intentionally limited to the app shell, logo rendering, and text-chat diagnosis. Production is not changed or deployed by this package.

## Logo fix

The original `public/tatv/tatv-mark.svg` had an unterminated quote in the final `stroke-width` attribute (`stroke-width="1/>`). It is now valid XML (`stroke-width="1"/>`). All visible broken logo instances use this same public asset path. A regression test parses the SVG as `image/svg+xml` and fails if the browser parser reports an error.

## Chat diagnosis from the 2026-11-06 screenshot

The screenshot shows an authenticated user session in the Workbench, but the chat response says:

`The private gateway has no enabled chat model for this request.`

The user sign-in is therefore not the missing step in this observed failure. The Workbench maps the gateway's `NO_PROVIDER_MODEL` error to this message. The next checks are:

1. Confirm the Workbench `CODEFORGE_GATEWAY_URL` points to the active private gateway deployment.
2. Confirm that gateway has at least one enabled **chat** model in its model catalog and that the model's provider credential is active.
3. Confirm the gateway trusts the same Supabase Auth project/issuer used by the Workbench.
4. Confirm the Workbench and gateway are both deployed and using the intended testing environment.

Do not add a gateway administrator key to the Workbench browser. Workbench forwards the signed-in user's Supabase access token; gateway provider credentials remain server-side in the gateway.

This import does **not** claim that chat is fixed. The chat error must be re-tested after the gateway model/catalog and environment configuration are checked.

## Deliberately unchanged

- Chat routing and gateway failover implementation.
- Image generation, video generation, and image/video failover.
- Plan limits, usage quotas, billing, and production settings.

## Validation status

- The SVG asset parses as XML after the fix.
- A regression test was added for browser SVG parsing.
- SVG XML validation passed.
- Dependency installation did not complete in this environment, so Vitest, lint, and the Cloudflare production build remain unverified.
- A Cloudflare Workers testing deployment guide documents the current Nitro target and the first text-chat variables.
- The package contains `.env.example` placeholders only; no real `.env` file is included.
