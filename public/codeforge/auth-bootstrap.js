// Keep a temporary Auth outage distinct from a genuinely signed-out session.
// Unknown/non-success responses fail closed: the browser must not discard a session
// merely because it could not verify that session at this moment.
export function classifyAuthBootstrap(response, payload) {
  if (!response || payload?.error === "AUTH_UNAVAILABLE") return "unavailable";
  const status = Number(response.status || 0);
  if (response.ok && payload?.user && typeof payload.user === "object") return "authenticated";
  if (response.ok || status === 401) return "signed-out";
  if ([408, 425, 429].includes(status) || status >= 500) return "unavailable";
  return "unavailable";
}

// A failed status lookup is not evidence that a paid entitlement has ended.
// Keep the last verified billing snapshot until a successful response replaces it.
export function preserveSubscriptionStatus(response, payload, current) {
  if (!response?.ok || payload?.error === "AUTH_UNAVAILABLE") return current;
  return {
    loaded: true,
    paid: payload?.paid === true,
    planCode: payload?.planCode || null,
    expiresAt: payload?.expiresAt || null,
  };
}

// An Auth outage must not be presented as a sign-in request.
export function shouldOpenAuthWelcome(user, authUnavailable) {
  return !user && authUnavailable !== true;
}
