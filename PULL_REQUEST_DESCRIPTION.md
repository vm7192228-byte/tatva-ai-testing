# Dhwani AI Testing — Universal Smart Routing and Brand Refresh

## Summary
- Apply the same Dhwani Smart routing order for the owner, signed-in users and guests: FreeLLMAPI first, eligible authenticated private gateways second, and configured direct providers last.
- Keep the FreeLLMAPI unified key server-side and never forward it to a private gateway.
- Preserve user-level authentication, suspension, permissions, quota and content-policy decisions as terminal; never replay after output or tool side effects begin.
- Sanitize upstream diagnostics into a neutral user-facing failure message.
- Replace all customer-facing Tatv AI names and logos with the Dhwani AI sound-wave identity, including login/signup, app shell, assistant avatars, loading indicators, plan screens, favicon and public/legal pages.
- Remove the retired Tatv SVG and favicon assets and rename the old theme stylesheet.
- Fix the Supabase admin-key recursion that previously broke usage reservations.

## Verification
- Focused routing/provider/quota regression tests: passed.
- Changed server routing/quota lint: passed.
- Production build: passed.
- Vercel Preview: READY.
- Branding regression tests are included in the next CI run for this updated commit.

This PR changes the Testing repository only. It does not modify or deploy the Production Workbench.
