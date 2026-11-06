import { getAuthenticatedSession } from "./auth-api.server";

type RuntimeEnv = Record<string, unknown>;
type ChatMessage = { role: "user" | "assistant"; content: string };

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

function json(data: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function validateMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const messages: ChatMessage[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const clean = content.trim();
    if (!clean || clean.length > 5000) return null;
    total += clean.length;
    if (total > 100_000) return null;
    messages.push({ role, content: clean });
  }
  return messages;
}

export async function handleConversationsApiRequest(
  request: Request,
  runtimeEnv: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/conversations") return null;
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "METHOD_NOT_ALLOWED", message: "Use GET, POST, or DELETE for saved conversations." }, 405);
  }
  if ((request.method === "POST" || request.method === "DELETE") && !sameOrigin(request)) {
    return json({ error: "ORIGIN_NOT_ALLOWED", message: "This request origin is not allowed." }, 403);
  }

  const session = await getAuthenticatedSession(request, runtimeEnv);
  if (!session.configured) {
    return json({ error: "AUTH_NOT_CONFIGURED", message: "Configure Supabase authentication before saving account conversations." }, 503);
  }
  if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503);
  if (!session.user || !session.accessToken) {
    return json({ error: "AUTH_REQUIRED", message: "Sign in to sync conversations across devices." }, 401, session.cookies);
  }

  const rawUrl = envValue("SUPABASE_URL", runtimeEnv);
  const key = envValue("SUPABASE_ANON_KEY", runtimeEnv) ?? envValue("SUPABASE_PUBLISHABLE_KEY", runtimeEnv);
  if (!rawUrl || !key) {
    return json({ error: "DATABASE_NOT_CONFIGURED", message: "Supabase database connection is not configured." }, 503, session.cookies);
  }

  const headers = new Headers({
    apikey: key,
    authorization: "Bearer " + session.accessToken,
    "content-type": "application/json",
  });

  if (request.method === "GET") {
    try {
      const response = await fetch(
        rawUrl.replace(/\/$/, "") +
          "/rest/v1/conversations?select=id,title,messages,created_at,updated_at&order=updated_at.desc&limit=50",
        { headers, signal: AbortSignal.timeout(12_000) },
      );
      if (!response.ok) {
        console.error("[Dhwani AI] Conversation list failed", { status: response.status });
        return json({ error: "CONVERSATIONS_LOAD_FAILED", message: "Saved conversations could not be loaded. Check the database setup." }, 502, session.cookies);
      }
      return json({ ok: true, conversations: await response.json() }, 200, session.cookies);
    } catch {
      return json({ error: "DATABASE_UNAVAILABLE", message: "Could not reach the database. Please try again." }, 502, session.cookies);
    }
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return json({ error: "INVALID_CONVERSATION_ID", message: "A valid conversation ID is required." }, 400, session.cookies);
    }
    try {
      const response = await fetch(
        rawUrl.replace(/\/$/, "") +
          "/rest/v1/conversations?id=eq." + encodeURIComponent(id) +
          "&user_id=eq." + encodeURIComponent(session.user.id),
        {
          method: "DELETE",
          headers: new Headers([
            ...headers.entries(),
            ["prefer", "return=representation"],
          ]),
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (!response.ok) {
        console.error("[Dhwani AI] Conversation delete failed", { status: response.status });
        return json({ error: "CONVERSATION_DELETE_FAILED", message: "This conversation could not be deleted. Please retry." }, 502, session.cookies);
      }
      const deletedRows = await response.json().catch(() => []);
      if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
        return json({ error: "CONVERSATION_NOT_FOUND", message: "This conversation was not found or is no longer available." }, 404, session.cookies);
      }
      return json({ ok: true, deleted: true }, 200, session.cookies);
    } catch {
      return json({ error: "DATABASE_UNAVAILABLE", message: "Could not reach the database. Please retry deleting this chat." }, 502, session.cookies);
    }
  }

  let payload: { id?: unknown; title?: unknown; messages?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ error: "INVALID_JSON", message: "Send a valid JSON conversation." }, 400, session.cookies);
  }
  const id = typeof payload.id === "string" ? payload.id : "";
  const title = typeof payload.title === "string" ? payload.title.trim().slice(0, 160) : "";
  const messages = validateMessages(payload.messages);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      !title || !messages || messages.length === 0) {
    return json({ error: "INVALID_CONVERSATION", message: "Conversation details are invalid or too large." }, 400, session.cookies);
  }

  try {
    const response = await fetch(
      rawUrl.replace(/\/$/, "") + "/rest/v1/conversations?on_conflict=id",
      {
        method: "POST",
        headers: new Headers([
          ...headers.entries(),
          ["prefer", "resolution=merge-duplicates,return=minimal"],
        ]),
        body: JSON.stringify([{
          id,
          user_id: session.user.id,
          title,
          messages,
          updated_at: new Date().toISOString(),
        }]),
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) {
      const status = response.status;
      const detail = (await response.text().catch(() => "")).slice(0, 180);
      console.error("[Dhwani AI] Conversation save failed", { status, detail });
      return json({ error: "CONVERSATION_SAVE_FAILED", message: "This conversation could not be saved. Please retry." }, 502, session.cookies);
    }
    return json({ ok: true, saved: true }, 200, session.cookies);
  } catch {
    return json({ error: "DATABASE_UNAVAILABLE", message: "Could not reach the database. Please retry saving." }, 502, session.cookies);
  }
}
