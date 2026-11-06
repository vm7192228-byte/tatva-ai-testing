/**
 * Build server-side Supabase Data/Storage API headers.
 *
 * Legacy service_role keys are JWTs and are valid Bearer tokens. Modern
 * sb_* API keys are opaque API keys, not JWTs; send them in apikey only.
 */
export function supabaseServiceHeaders(
  serviceKey: string,
  extra: Record<string, string> = {},
): Headers {
  const headers = new Headers(extra);
  headers.set("apikey", serviceKey);
  if (serviceKey.startsWith("sb_")) {
    headers.delete("authorization");
  } else {
    headers.set("authorization", "Bearer " + serviceKey);
  }
  return headers;
}
