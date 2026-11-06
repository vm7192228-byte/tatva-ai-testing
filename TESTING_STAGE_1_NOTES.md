# Dhwani AI Testing — Stage 1

## Scope

This repository is the isolated Testing workspace. The current Testing branch contains the Dhwani AI brand refresh and universal Smart routing work. Production Workbench code, settings and deployments remain separate.

## Dhwani logo and sign-in branding

The canonical customer-facing brand asset is `public/dhwani/dhwani-mark.svg`. It is used by the sign-in/sign-up overlay, sidebar, top bar, assistant avatars, loading indicators, subscription UI and browser favicon metadata.

The retired logo asset and old favicon have been removed. The app root metadata now declares Dhwani AI, and the old theme stylesheet has been renamed to `dhwani-theme.css`. Public About, Contact, Pricing, Terms, Privacy, Refund, Shipping and Data Deletion pages use Dhwani AI branding.

## Dhwani Smart routing

Dhwani Smart follows one server-side routing order for the owner, signed-in users and guests:

1. FreeLLMAPI first.
2. Authenticated private CodeForge gateway instances, using only the verified signed-in user's Supabase JWT.
3. Configured direct provider fallbacks.

Guests skip the private JWT-protected gateway tier. The shared FreeLLMAPI key is never sent to the browser or forwarded to a private gateway. Upstream provider errors are sanitized; user access, suspension, permission, quota and content-policy decisions remain terminal. A request is not replayed after answer text or tool side effects begin.

## Quota safety

The recursive Supabase admin-key lookup in the testing copy caused stack overflows and 503 responses in quota tests. The helper now reads the configured Supabase server key directly, while image, video and file-analysis quota reservations remain enforced.

## Verification

- Focused routing, provider and quota regression tests: passed in CI.
- Changed server routing and quota lint: passed in CI.
- Production application build: passed in CI.
- Vercel Preview deployment: READY.
- Branding regression tests are being added to the same Testing CI gate.
