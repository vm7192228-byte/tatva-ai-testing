import { consumeSharedRateLimit } from "./shared-rate-limit.server";

type RuntimeEnv = Record<string, unknown>;

export type TatvUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  age?: number;
};

type AuthPayload = {
  access_token?: string;
  refresh_token?: string;
  user?: SupabaseUser;
  message?: string;
  msg?: string;
  error_description?: string;
};

type SupabaseUser = {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

type SupabaseConfig = { url: string; key: string };

export type AuthSession = {
  configured: boolean;
  user: TatvUser | null;
  accessToken?: string;
  /** Upstream Auth was unavailable; preserve tokens and let callers retry. */
  unavailable?: boolean;
  cookies: string[];
};

const authAttempts = new Map<string, { count: number; resetsAt: number }>();
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_ATTEMPTS = 12;

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object"
    ? (runtimeEnv as RuntimeEnv)[name]
    : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configFromEnv(runtimeEnv: unknown): SupabaseConfig | null {
  // Prefer app-owned variables over Vercel Marketplace integration variables.
  // This prevents an attached Supabase integration for another project from
  // silently routing Google/Auth requests to that project's Auth endpoint.
  const rawUrl = envValue("TATV_SUPABASE_URL", runtimeEnv)
    ?? envValue("SUPABASE_URL", runtimeEnv);
  const key = envValue("TATV_SUPABASE_PUBLISHABLE_KEY", runtimeEnv)
    ?? envValue("SUPABASE_PUBLISHABLE_KEY", runtimeEnv)
    ?? envValue("SUPABASE_ANON_KEY", runtimeEnv);
  if (!rawUrl || !key) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return null;
    return { url: parsed.origin, key };
  } catch {
    return null;
  }
}

function json(
  data: unknown,
  status = 200,
  cookies: string[] = [],
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function secureCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function sessionCookies(request: Request, accessToken?: string, refreshToken?: string): string[] {
  const maxAge = 60 * 60 * 24 * 7;
  if (!accessToken || !refreshToken) return clearSessionCookies(request);
  return [
    secureCookie(request, "cf_access", accessToken, maxAge),
    secureCookie(request, "cf_refresh", refreshToken, maxAge),
  ];
}

function clearSessionCookies(request: Request): string[] {
  return [
    secureCookie(request, "cf_access", "", 0),
    secureCookie(request, "cf_refresh", "", 0),
  ];
}

function cookiesFromRequest(request: Request): Record<string, string> {
  const output: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    try { output[key] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { output[key] = part.slice(index + 1).trim(); }
  }
  return output;
}

function normalizeUser(user: SupabaseUser | undefined): TatvUser | null {
  if (!user || typeof user.id !== "string" || typeof user.email !== "string") return null;
  const metadata = user.user_metadata ?? {};
  const displayName = typeof metadata["display_name"] === "string"
    ? metadata["display_name"]
    : typeof metadata["name"] === "string" ? metadata["name"] : "";
  const age = Number(metadata["age"]);
  return {
    id: user.id,
    email: user.email,
    displayName: displayName.trim() || user.email.split("@")[0] || "Tatv user",
    avatarUrl: typeof metadata["avatar_url"] === "string" ? metadata["avatar_url"] : "",
    ...(Number.isInteger(age) && age >= 13 && age <= 120 ? { age } : {}),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeUpstreamMessage(payload: Record<string, unknown>, fallback: string): string {
  const value = payload["msg"] ?? payload["message"] ?? payload["error_description"];
  return typeof value === "string" && value.length < 240 ? value : fallback;
}

async function supabaseRequest(
  config: SupabaseConfig,
  path: string,
  init: RequestInit = {},
  accessToken?: string,
  timeoutMs = 15_000,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", config.key);
  headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return fetch(`${config.url}/auth/v1/${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  // Browser POSTs without Origin are accepted only when Fetch Metadata
  // explicitly identifies a same-origin request. Missing metadata is not
  // treated as proof of same-origin intent.
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function isAuthServiceUnavailable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function authRateLimitedLocal(request: Request): { limited: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const key = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  for (const [address, record] of authAttempts) {
    if (record.resetsAt <= now) authAttempts.delete(address);
  }
  const current = authAttempts.get(key);
  if (!current || current.resetsAt <= now) {
    authAttempts.set(key, { count: 1, resetsAt: now + AUTH_WINDOW_MS });
    return { limited: false, retryAfterSeconds: 0 };
  }
  current.count += 1;
  return {
    limited: current.count > AUTH_MAX_ATTEMPTS,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetsAt - now) / 1_000)),
  };
}

async function authRateLimited(
  request: Request,
  runtimeEnv: unknown,
): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const identity = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  try {
    const decision = await consumeSharedRateLimit(runtimeEnv, "auth", identity, AUTH_MAX_ATTEMPTS, 60);
    return { limited: !decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
  } catch {
    // Local fallback preserves sign-in during a temporary shared-store outage.
    return authRateLimitedLocal(request);
  }
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 12_000) return null;
  try {
    const payload: unknown = JSON.parse(raw);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function getAuthenticatedSession(
  request: Request,
  runtimeEnv: unknown,
  timeoutMs = 15_000,
): Promise<AuthSession> {
  const config = configFromEnv(runtimeEnv);
  if (!config) return { configured: false, user: null, cookies: [] };
  const cookies = cookiesFromRequest(request);
  const accessToken = cookies["cf_access"];
  const refreshToken = cookies["cf_refresh"];
  let upstreamUnavailable = false;

  if (accessToken) {
    try {
      const response = await supabaseRequest(config, "user", { method: "GET" }, accessToken, timeoutMs);
      if (response.ok) {
        const payload = await readJson(response) as SupabaseUser;
        const user = normalizeUser(payload);
        if (user) return { configured: true, user, accessToken, cookies: [] };
      } else if (response.status === 408 || response.status === 425 ||
                 response.status === 429 || response.status >= 500) {
        upstreamUnavailable = true;
      }
    } catch {
      // A network/timeout failure is not evidence that the user's session is invalid.
      upstreamUnavailable = true;
    }
  }

  if (refreshToken) {
    try {
      const response = await supabaseRequest(config, "token?grant_type=refresh_token", {
        method: "POST",
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, undefined, timeoutMs);
      if (response.ok) {
        const payload = await readJson(response) as AuthPayload;
        const user = normalizeUser(payload["user"]);
        if (user && payload["access_token"] && payload["refresh_token"]) {
          return {
            configured: true,
            user,
            accessToken: payload["access_token"],
            cookies: sessionCookies(request, payload["access_token"], payload["refresh_token"]),
          };
        }
        // A malformed success response cannot safely replace the existing session.
        upstreamUnavailable = true;
      } else if (response.status === 408 || response.status === 425 ||
                 response.status === 429 || response.status >= 500) {
        upstreamUnavailable = true;
      }
    } catch {
      // Do not destroy a potentially valid refresh token during an Auth outage.
      upstreamUnavailable = true;
    }
  }

  if (upstreamUnavailable) {
    return { configured: true, user: null, unavailable: true, cookies: [] };
  }

  return {
    configured: true,
    user: null,
    cookies: accessToken || refreshToken ? clearSessionCookies(request) : [],
  };
}


/** Handles authentication/profile endpoints before the application router. */
export async function handleAuthApiRequest(
  request: Request,
  runtimeEnv: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth")) return null;

  if ((url.pathname === "/api/auth/google" || url.pathname === "/api/auth/facebook" || url.pathname === "/api/auth/github") && request.method === "GET") {
    const provider = url.pathname.endsWith("/facebook") ? "facebook" : url.pathname.endsWith("/github") ? "github" : "google";
    const config = configFromEnv(runtimeEnv);
    if (!config) return json({ error: "AUTH_NOT_CONFIGURED", message: provider === "facebook" ? "Facebook sign-in needs Supabase Auth configured on the server." : provider === "github" ? "GitHub sign-in needs Supabase Auth configured on the server." : "Google sign-in needs Supabase Auth configured on the server." }, 503);
    const redirectTo = new URL("/", request.url).toString();
    const authorize = new URL(config.url + "/auth/v1/authorize");
    authorize.searchParams.set("provider", provider);
    authorize.searchParams.set("redirect_to", redirectTo);
    if (provider === "google") authorize.searchParams.set("prompt", "select_account");
    return new Response(null, { status: 302, headers: { location: authorize.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (!session.configured) {
      return json({
        error: "AUTH_NOT_CONFIGURED",
        message: "Login needs SUPABASE_URL and SUPABASE_ANON_KEY in the server environment. Add them in your hosting settings, then redeploy.",
      }, 503);
    }
    if (session.unavailable) {
      return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your session has been preserved; please retry." }, 503);
    }
    return json({ ok: true, user: session.user }, 200, session.cookies);
  }

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED", message: "Use GET or POST for this authentication endpoint." }, 405, [], { allow: "GET, POST" });
  }
  if (!sameOrigin(request)) return json({ error: "ORIGIN_NOT_ALLOWED", message: "This request origin is not allowed." }, 403);
  const authLimit = await authRateLimited(request, runtimeEnv);
  if (authLimit.limited) {
    return json(
      { error: "RATE_LIMITED", message: "Too many account requests. Please wait a minute and try again." },
      429,
      [],
      { "retry-after": String(authLimit.retryAfterSeconds) },
    );
  }

  const config = configFromEnv(runtimeEnv);
  if (!config) {
    return json({
      error: "AUTH_NOT_CONFIGURED",
      message: "Login needs SUPABASE_URL and SUPABASE_ANON_KEY in the server environment. Add them in your hosting settings, then redeploy.",
    }, 503);
  }

  if (url.pathname === "/api/auth/session") {
    const payload = await parseBody(request);
    const accessToken = typeof payload?.["accessToken"] === "string" ? payload["accessToken"] : "";
    const refreshToken = typeof payload?.["refreshToken"] === "string" ? payload["refreshToken"] : "";
    if (accessToken.length < 20 || accessToken.length > 5_000 || refreshToken.length < 10 || refreshToken.length > 2_000) {
      return json({ error: "INVALID_SESSION", message: "Google sign-in could not be verified. Please try again." }, 400);
    }
    try {
      const upstream = await supabaseRequest(config, "user", { method: "GET" }, accessToken);
      if (!upstream.ok) {
        if (isAuthServiceUnavailable(upstream.status)) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Please retry sign-in." }, 503);
        return json({ error: "INVALID_SESSION", message: "Google sign-in could not be verified. Please try again." }, 401);
      }
      const user = normalizeUser(await readJson(upstream) as SupabaseUser);
      if (!user) return json({ error: "INVALID_SESSION", message: "The account service returned an invalid profile." }, 401);
      return json({ ok: true, user }, 200, sessionCookies(request, accessToken, refreshToken));
    } catch {
      return json({ error: "AUTH_UNAVAILABLE", message: "Could not verify Google sign-in. Please try again." }, 503);
    }
  }

  if (url.pathname === "/api/auth/logout") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) {
      return json({
        error: "LOGOUT_REVOCATION_UNCONFIRMED",
        message: "This browser was signed out, but the account service could not verify or revoke the remote session.",
      }, 502, clearSessionCookies(request));
    }
    if (!session.user || !session.accessToken) {
      return json({ ok: true }, 200, clearSessionCookies(request));
    }
    try {
      // Revoke only the current Supabase session; do not sign the user out
      // globally from other browsers or devices.
      const upstream = await supabaseRequest(
        config,
        "logout?scope=local",
        { method: "POST" },
        session.accessToken,
      );
      if (!upstream.ok) {
        try { await upstream.body?.cancel(); } catch { /* The browser session is cleared regardless. */ }
        return json({
          error: "LOGOUT_REVOCATION_UNCONFIRMED",
          message: "This browser was signed out, but the account service did not confirm remote session revocation.",
        }, 502, clearSessionCookies(request));
      }
      return json({ ok: true }, 200, clearSessionCookies(request));
    } catch {
      return json({
        error: "LOGOUT_REVOCATION_UNCONFIRMED",
        message: "This browser was signed out, but the account service could not confirm remote session revocation.",
      }, 502, clearSessionCookies(request));
    }
  }

  if (url.pathname === "/api/auth/recovery-session") {
    const payload = await parseBody(request);
    const accessToken = typeof payload?.["accessToken"] === "string" ? payload["accessToken"] : "";
    const refreshToken = typeof payload?.["refreshToken"] === "string" ? payload["refreshToken"] : "";
    if (accessToken.length < 20 || accessToken.length > 5_000 || refreshToken.length < 10 || refreshToken.length > 2_000) {
      return json({ error: "INVALID_RECOVERY_SESSION", message: "This password-reset link is invalid or has expired. Request a new link." }, 400);
    }
    try {
      const upstream = await supabaseRequest(config, "user", { method: "GET" }, accessToken);
      if (!upstream.ok) {
        if (isAuthServiceUnavailable(upstream.status)) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Please retry the password-reset link." }, 503);
        return json({ error: "INVALID_RECOVERY_SESSION", message: "This password-reset link is invalid or has expired. Request a new link." }, 401);
      }
      const user = normalizeUser(await readJson(upstream) as SupabaseUser);
      if (!user) return json({ error: "INVALID_RECOVERY_SESSION", message: "The account service returned an invalid recovery session." }, 401);
      return json({ ok: true, user, recovery: true }, 200, sessionCookies(request, accessToken, refreshToken));
    } catch {
      return json({ error: "AUTH_UNAVAILABLE", message: "Could not verify the reset link. Please try again." }, 503);
    }
  }

  if (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/signup") {
    const payload = await parseBody(request);
    if (!payload) return json({ error: "INVALID_BODY", message: "Enter a valid form and try again." }, 400);
    const email = typeof payload["email"] === "string" ? payload["email"].trim().toLowerCase() : "";
    const password = typeof payload["password"] === "string" ? payload["password"] : "";
    const displayName = typeof payload["displayName"] === "string" ? payload["displayName"].trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
      return json({ error: "INVALID_CREDENTIALS", message: "Enter a valid email and a password of at least 8 characters." }, 400);
    }
    const isSignup = url.pathname.endsWith("/signup");
    if (isSignup && (displayName.length < 1 || displayName.length > 70)) {
      return json({ error: "INVALID_NAME", message: "Enter a name between 1 and 70 characters." }, 400);
    }
    try {
      const redirectTo = new URL("/", request.url).toString();
      const authPath = isSignup ? `signup?redirect_to=${encodeURIComponent(redirectTo)}` : "token?grant_type=password";
      const upstream = await supabaseRequest(config, authPath, {
        method: "POST",
        body: JSON.stringify(isSignup
          ? { email, password, data: { display_name: displayName, name: displayName } }
          : { email, password }),
      });
      const result = await readJson(upstream) as AuthPayload;
      if (!upstream.ok) {
        if (upstream.status === 429) return json({ error: "RATE_LIMITED", message: "Too many attempts. Please wait before trying again." }, 429);
        if (isAuthServiceUnavailable(upstream.status)) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Please retry." }, 503);
        const message = isSignup
          ? "Account could not be created. Check your email and password, or try logging in."
          : "Email or password is incorrect.";
        return json({ error: "AUTH_FAILED", message: upstream.status === 429
          ? "Too many attempts. Please wait before trying again."
          : safeUpstreamMessage(result as Record<string, unknown>, message) }, upstream.status === 429 ? 429 : 400);
      }
      const user = normalizeUser(result.user);
      if (isSignup && (!result.access_token || !result.refresh_token || !user)) {
        return json({
          ok: true,
          confirmationRequired: true,
          message: "Your account was created. Check your email to confirm it, then log in.",
        });
      }
      if (!user || !result.access_token || !result.refresh_token) {
        return json({ error: "AUTH_FAILED", message: "The account service did not return a complete session. Please try again." }, 502);
      }
      return json({ ok: true, user }, 200, sessionCookies(request, result.access_token, result.refresh_token));
    } catch {
      return json({ error: "AUTH_UNAVAILABLE", message: "The account service could not be reached. Please try again shortly." }, 503);
    }
  }

  if (url.pathname === "/api/auth/recover") {
    const payload = await parseBody(request);
    const email = typeof payload?.["email"] === "string" ? payload["email"].trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "INVALID_EMAIL", message: "Enter a valid email address." }, 400);
    }
    try {
      const redirectTo = new URL("/", request.url).toString();
      const upstream = await supabaseRequest(config, `recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      if (!upstream.ok) {
        if (upstream.status === 429) return json({ error: "RATE_LIMITED", message: "Too many password reset requests. Please wait and try again." }, 429);
        if (isAuthServiceUnavailable(upstream.status)) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Please retry shortly." }, 503);
        return json({ error: "RECOVERY_FAILED", message: "Password reset could not be requested. Check your email settings and try again." }, 400);
      }
      return json({ ok: true, message: "If an account exists for that email, a password reset link will be sent." });
    } catch {
      return json({ error: "AUTH_UNAVAILABLE", message: "The account service could not be reached. Please try again shortly." }, 503);
    }
  }

  if (url.pathname === "/api/auth/profile") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (!session.configured) return json({ error: "AUTH_NOT_CONFIGURED", message: "Account authentication is not configured on the server yet." }, 503);
    if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Please retry." }, 503);
    if (!session.user || !session.accessToken) return json({ error: "AUTH_REQUIRED", message: "Log in again to update your profile." }, 401, session.cookies);
    const payload = await parseBody(request);
    if (!payload) return json({ error: "INVALID_BODY", message: "The profile form is invalid." }, 400, session.cookies);
    const displayName = typeof payload["displayName"] === "string" ? payload["displayName"].trim() : "";
    const avatarUrl = typeof payload["avatarUrl"] === "string" ? payload["avatarUrl"].trim() : "";
    const password = typeof payload["newPassword"] === "string" ? payload["newPassword"] : "";
    const ageProvided = Object.prototype.hasOwnProperty.call(payload, "age");
    const age = typeof payload["age"] === "number" ? payload["age"] : Number(payload["age"]);
    if (displayName.length < 1 || displayName.length > 70) {
      return json({ error: "INVALID_NAME", message: "Your name must be between 1 and 70 characters." }, 400, session.cookies);
    }
    if (avatarUrl && (avatarUrl.length > 500 || !/^https:\/\//i.test(avatarUrl))) {
      return json({ error: "INVALID_AVATAR", message: "Profile image links must start with https://." }, 400, session.cookies);
    }
    if (ageProvided && (!Number.isInteger(age) || age < 13 || age > 120)) return json({ error: "INVALID_AGE", message: "Enter a valid age between 13 and 120." }, 400, session.cookies);
    if (password && password.length < 8) return json({ error: "WEAK_PASSWORD", message: "A new password must contain at least 8 characters." }, 400, session.cookies);
    if (password.length > 128) return json({ error: "WEAK_PASSWORD", message: "Password is too long." }, 400, session.cookies);
    try {
      const body: Record<string, unknown> = {
        data: { display_name: displayName, name: displayName, avatar_url: avatarUrl, ...(ageProvided ? { age } : {}) },
      };
      if (password) body["password"] = password;
      const upstream = await supabaseRequest(config, "user", {
        method: "PUT",
        body: JSON.stringify(body),
      }, session.accessToken);
      const result = await readJson(upstream) as SupabaseUser;
      if (!upstream.ok) {
        return json({ error: "PROFILE_UPDATE_FAILED", message: "Your profile could not be saved. Please check the form and try again." }, 400, session.cookies);
      }
      const user = normalizeUser(result);
      if (!user) return json({ error: "PROFILE_UPDATE_FAILED", message: "The account service returned an invalid profile." }, 502, session.cookies);
      return json({ ok: true, user, passwordUpdated: Boolean(password) }, 200, session.cookies);
    } catch {
      return json({ error: "AUTH_UNAVAILABLE", message: "The account service could not be reached. Please try again." }, 502, session.cookies);
    }
  }

  return json({ error: "NOT_FOUND", message: "Authentication endpoint not found." }, 404);
}
