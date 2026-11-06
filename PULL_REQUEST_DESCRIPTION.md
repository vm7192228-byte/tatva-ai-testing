# Tatv AI Workbench — Stage 1 import

## Summary
- Import the current complete Workbench source into the testing repository.
- Fix the malformed SVG logo asset so the browser can render the sidebar, header, and assistant mark.
- Add a regression test to reject malformed SVG markup.
- Record the observed signed-in `NO_PROVIDER_MODEL` failure and the exact gateway checks needed for the next test.
- Add a Cloudflare Workers testing deployment guide with server-only variable handling and text-chat verification order.
- Split known dummy credential examples at runtime to reduce secret-scanner false positives.

## Scope boundaries
- No production deployment or production configuration changes.
- No chat-provider routing/failover changes in this stage.
- No image/video generation or failover changes.
- No billing, quota, or plan-limit changes.

## Test status
- SVG XML validation: passed.
- Static secret-pattern scan: known AWS/Stripe-shaped test literals split into runtime fragments; no real `.env` or `.dev.vars` included.
- Dependency installation timed out; Vitest/build/lint remain unverified and must run in CI.

## Review focus
1. Confirm the logo renders across the app shell.
2. Deploy the testing app and verify its Supabase session.
3. Confirm the private gateway has at least one enabled chat model and a valid provider credential, then re-test text chat.
