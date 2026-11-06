import { getAuthenticatedSession } from "./auth-api.server";
type RuntimeEnv = Record<string, unknown>;
type GitHubToken = { accessToken: string; tokenType: string; scope: string; ownerUserId: string; login?: string; avatarUrl?: string; name?: string };

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object" ? (runtimeEnv as RuntimeEnv)[name] : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function json(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  cookies.forEach(value => headers.append("set-cookie", value));
  return new Response(JSON.stringify(data), { status, headers });
}
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  cookies.forEach(value => headers.append("set-cookie", value));
  return new Response(null, { status: 302, headers });
}
function baseUrl(request: Request, runtimeEnv: unknown): string {
  return (envValue("PUBLIC_APP_URL", runtimeEnv) ?? new URL(request.url).origin).replace(/\/$/, "");
}
function secureCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secure;
}
function readCookie(request: Request, name: string): string | undefined {
  const part = (request.headers.get("cookie") ?? "").split(/;\s*/).find(value => value.startsWith(name + "="));
  if (!part) return undefined;
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return undefined; }
}
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
function secretValue(runtimeEnv: unknown): string | undefined {
  return envValue("GITHUB_TOKEN_SECRET", runtimeEnv) ?? envValue("SOCIAL_TOKEN_SECRET", runtimeEnv);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}
async function cryptoKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function sealToken(token: GitHubToken, secret: string): Promise<string> {
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(secret), encoder.encode(JSON.stringify(token)));
  return toBase64Url(iv) + "." + toBase64Url(new Uint8Array(encrypted));
}
async function unsealToken(value: string | undefined, secret: string): Promise<GitHubToken | null> {
  if (!value) return null;
  try {
    const [iv, ciphertext] = value.split(".");
    if (!iv || !ciphertext) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, await cryptoKey(secret), fromBase64Url(ciphertext));
    const result = JSON.parse(decoder.decode(plain)) as GitHubToken;
    return typeof result.accessToken === "string" && result.accessToken.length > 10 ? result : null;
  } catch { return null; }
}
async function getToken(request: Request, runtimeEnv: unknown, ownerUserId: string): Promise<GitHubToken | null> {
  const secret = secretValue(runtimeEnv);
  if (!secret) return null;
  const token = await unsealToken(readCookie(request, "cf_github_token"), secret);
  return token?.ownerUserId === ownerUserId ? token : null;
}
function callbackUrl(request: Request, runtimeEnv: unknown): string {
  return baseUrl(request, runtimeEnv) + "/api/github/callback";
}
async function githubRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + token);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", "2022-11-28");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch("https://api.github.com" + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
}
async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try { const data: unknown = await response.json(); return data && typeof data === "object" ? data as Record<string, unknown> : {}; }
  catch { return {}; }
}
async function requireToken(request: Request, runtimeEnv: unknown): Promise<{ token: GitHubToken; cookies: string[] } | { response: Response }> {
  const session = await getAuthenticatedSession(request, runtimeEnv);
  if (session.unavailable) return { response: json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503, session.cookies) };
  if (!session.user) return { response: json({ error: "AUTH_REQUIRED", message: "Sign in to Tatv AI before connecting GitHub." }, 401, session.cookies) };
  const token = await getToken(request, runtimeEnv, session.user["id"]);
  if (!token) return { response: json({ error: "GITHUB_NOT_CONNECTED", message: "Connect your GitHub account to this Tatv AI account first." }, 401, session.cookies) };
  return { token, cookies: session.cookies };
}
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 1_500_000) return null;
  try { const value: unknown = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
function repoName(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  const [owner, name] = value.split("/");
  return owner && name && owner !== "." && owner !== ".." && name !== "." && name !== ".." ? value : null;
}
function safePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) return null;
  return value;
}

/** GitHub OAuth and repository workflow endpoints. Tokens are encrypted in HttpOnly cookies and never sent to the browser. */
export async function handleGitHubApiRequest(request: Request, runtimeEnv: unknown): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/github")) return null;
  const path = url.pathname.replace(/^\/api\/github\/?/, "");
  const clientId = envValue("GITHUB_CLIENT_ID", runtimeEnv);
  // Keep compatibility with the already-configured Vercel variable that used a lowercase "l" typo.
  const clientSecret = envValue("GITHUB_CLIENT_SECRET", runtimeEnv) ?? envValue("GITHUB_ClIENT_SECRET", runtimeEnv);
  const secret = secretValue(runtimeEnv);
  const callback = callbackUrl(request, runtimeEnv);

  if (path === "status" && request.method === "GET") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503, session.cookies);
    const token = secret && session.user ? await getToken(request, runtimeEnv, session.user["id"]) : null;
    return json({ id: "github", configured: Boolean(clientId && clientSecret && secret), connected: Boolean(token), requiresSignIn: !session.user, login: token?.login ?? null, avatarUrl: token?.avatarUrl ?? null, missing: [!clientId ? "GITHUB_CLIENT_ID" : "", !clientSecret ? "GITHUB_CLIENT_SECRET" : "", !secret ? "GITHUB_TOKEN_SECRET (or SOCIAL_TOKEN_SECRET)" : ""].filter(Boolean) }, 200, session.cookies);
  }
  if (path === "connect" && request.method === "GET") {
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503, session.cookies);
    if (!session.user) return json({ error: "AUTH_REQUIRED", message: "Sign in to Tatv AI before connecting GitHub." }, 401, session.cookies);
    if (!clientId || !clientSecret || !secret) return json({ error: "GITHUB_NOT_CONFIGURED", message: "GitHub OAuth requires the client ID, client secret and token-encryption secret in server environment variables." }, 503, session.cookies);
    const state = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, scope: "repo read:user user:email", state, allow_signup: "true" }).toString();
    return redirect(authorize.toString(), [secureCookie(request, "cf_github_state", session.user["id"] + "." + state, 600), ...session.cookies]);
  }
  if (path === "callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const savedState = readCookie(request, "cf_github_state");
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503, session.cookies);
    const [stateOwnerId, expectedState] = savedState?.split(".", 2) ?? [];
    if (url.searchParams.has("error") || !code || !state || !session.user || session.user["id"] !== stateOwnerId || state !== expectedState) {
      return redirect("/?github=error", [secureCookie(request, "cf_github_state", "", 0), ...session.cookies]);
    }
    if (!clientId || !clientSecret || !secret) return redirect("/?github=not-configured", [secureCookie(request, "cf_github_state", "", 0), ...session.cookies]);
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenPayload = await readPayload(tokenResponse);
    if (!tokenResponse.ok || typeof tokenPayload["access_token"] !== "string") return redirect("/?github=error", [secureCookie(request, "cf_github_state", "", 0), ...session.cookies]);
    const accessToken = tokenPayload["access_token"];
    const userResponse = await githubRequest("/user", accessToken);
    const user = await readPayload(userResponse);
    if (!userResponse.ok || typeof user["login"] !== "string") return redirect("/?github=error", [secureCookie(request, "cf_github_state", "", 0), ...session.cookies]);
    const stored: GitHubToken = {
      accessToken,
      ownerUserId: session.user["id"],
      tokenType: typeof tokenPayload["token_type"] === "string" ? tokenPayload["token_type"] : "bearer",
      scope: typeof tokenPayload["scope"] === "string" ? tokenPayload["scope"] : "",
      login: user["login"],
      avatarUrl: typeof user["avatar_url"] === "string" ? user["avatar_url"] : "",
      name: typeof user["name"] === "string" ? user["name"] : user["login"],
    };
    return redirect("/?github=connected", [
      secureCookie(request, "cf_github_token", await sealToken(stored, secret), 60 * 60 * 24 * 30),
      secureCookie(request, "cf_github_state", "", 0),
      ...session.cookies,
    ]);
  }

  if (path === "disconnect" && request.method === "POST") {
    if (!sameOrigin(request)) return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
    const session = await getAuthenticatedSession(request, runtimeEnv);
    if (session.unavailable) return json({ error: "AUTH_UNAVAILABLE", message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry." }, 503, session.cookies);
    if (!session.user) return json({ error: "AUTH_REQUIRED", message: "Sign in to Tatv AI before disconnecting GitHub." }, 401, session.cookies);
    const token = secret ? await getToken(request, runtimeEnv, session.user["id"]) : null;
    let revoked = false;
    if (token && clientId && clientSecret) {
      try {
        const credentials = btoa(clientId + ":" + clientSecret);
        const response = await fetch("https://api.github.com/applications/" + encodeURIComponent(clientId) + "/grant", {
          method: "DELETE",
          headers: { authorization: "Basic " + credentials, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
          body: JSON.stringify({ access_token: token.accessToken }),
          signal: AbortSignal.timeout(10_000),
        });
        revoked = response.ok || response.status === 404;
      } catch { /* Local disconnect still clears the encrypted browser credential. */ }
    }
    return json({ ok: true, revoked }, 200, [secureCookie(request, "cf_github_token", "", 0), ...session.cookies]);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (request.method === "POST" && !sameOrigin(request)) return json({ error: "ORIGIN_NOT_ALLOWED", message: "This GitHub action must come from Tatv AI." }, 403);

  const auth = await requireToken(request, runtimeEnv);
  if ("response" in auth) return auth.response;
  const token = auth.token;
  const respond = (data: unknown, status = 200) => json(data, status, auth.cookies);

  try {
    if (path === "repos" && request.method === "GET") {
      const response = await githubRequest("/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member", token.accessToken);
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "GITHUB_API_ERROR", message: typeof payload["message"] === "string" ? payload["message"] : "Could not load repositories." }, response.status);
      const repos = Array.isArray(payload) ? payload["filter"]((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
      return respond({ ok: true, repositories: repos.map(repo => ({ id: repo["id"], name: repo["name"], fullName: repo["full_name"], description: repo["description"], private: repo["private"], defaultBranch: repo["default_branch"], updatedAt: repo["updated_at"], htmlUrl: repo["html_url"], permissions: repo["permissions"] ?? {} })) });
    }
    if (path === "tree" && request.method === "GET") {
      const repo = repoName(url.searchParams.get("repo"));
      const branch = (url.searchParams.get("branch") ?? "").slice(0, 150);
      if (!repo) return respond({ error: "INVALID_REPOSITORY" }, 400);
      const repoResponse = await githubRequest("/repos/" + repo, token.accessToken);
      const repoData = await readPayload(repoResponse);
      if (!repoResponse.ok) return respond({ error: "GITHUB_API_ERROR", message: "Repository could not be opened." }, repoResponse.status);
      const ref = branch || String(repoData["default_branch"] || "main");
      const treeResponse = await githubRequest("/repos/" + repo + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1", token.accessToken);
      const treeData = await readPayload(treeResponse);
      if (!treeResponse.ok) return respond({ error: "GITHUB_API_ERROR", message: typeof treeData["message"] === "string" ? treeData["message"] : "Could not read repository tree." }, treeResponse.status);
      const entries = Array.isArray(treeData["tree"]) ? treeData["tree"].filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
      return respond({ ok: true, repository: { fullName: repo, defaultBranch: repoData["default_branch"], private: repoData["private"] }, truncated: treeData["truncated"] === true, files: entries.filter(item => item["type"] === "blob").slice(0, 500).map(item => ({ path: item["path"], sha: item["sha"], size: item["size"] })) });
    }
    if (path === "file" && request.method === "GET") {
      const repo = repoName(url.searchParams.get("repo"));
      const filePath = safePath(url.searchParams.get("path"));
      const ref = (url.searchParams.get("ref") ?? "").slice(0, 150);
      if (!repo || !filePath) return respond({ error: "INVALID_FILE_REQUEST" }, 400);
      const endpoint = "/repos/" + repo + "/contents/" + filePath.split("/").map(encodeURIComponent).join("/") + (ref ? "?ref=" + encodeURIComponent(ref) : "");
      const response = await githubRequest(endpoint, token.accessToken);
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "GITHUB_API_ERROR", message: typeof payload["message"] === "string" ? payload["message"] : "Could not read file." }, response.status);
      if (payload["type"] !== "file" || typeof payload["content"] !== "string" || payload["encoding"] !== "base64") return respond({ error: "NOT_A_TEXT_FILE", message: "This item is not a readable text file or GitHub did not return a supported base64 payload." }, 415);
      const decoded = atob(payload["content"].replace(/\s/g, ""));
      const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      const content = decoder.decode(bytes);
      if (content.includes("\0")) return respond({ error: "BINARY_FILE_NOT_SUPPORTED", message: "This workspace editor only opens text files." }, 415);
      if (content.length > 500_000) return respond({ error: "FILE_TOO_LARGE", message: "This file is too large to import into the workspace." }, 413);
      return respond({ ok: true, file: { path: filePath, content, sha: payload["sha"], size: payload["size"], encoding: payload["encoding"] } });
    }
    if (path === "commit" && request.method === "POST") {
      const body = await readBody(request);
      const repo = repoName(body?.["repo"]);
      const branch = typeof body?.["branch"] === "string" ? body["branch"].trim().slice(0, 150) : "";
      const filePath = safePath(body?.["path"]);
      const content = typeof body?.["content"] === "string" ? body["content"] : null;
      const message = typeof body?.["message"] === "string" ? body["message"].trim().slice(0, 200) : "";
      const expectedSha = typeof body?.["expectedSha"] === "string" ? body["expectedSha"] : "";
      if (!body || !repo || !branch || !filePath || content === null || content.length > 500_000 || !message) return respond({ error: "INVALID_COMMIT", message: "Repository, branch, file path, content and commit message are required." }, 400);
      const repoResponse = await githubRequest("/repos/" + repo, token.accessToken);
      const repoData = await readPayload(repoResponse);
      if (!repoResponse.ok) return respond({ error: "REPOSITORY_UNAVAILABLE", message: "Repository could not be verified." }, repoResponse.status);
      if (branch === repoData["default_branch"]) return respond({ error: "DEFAULT_BRANCH_PROTECTED", message: "Create a feature branch before committing. The default branch cannot be edited from this workspace." }, 409);
      const branchResponse = await githubRequest("/repos/" + repo + "/branches/" + encodeURIComponent(branch), token.accessToken);
      if (!branchResponse.ok) return respond({ error: "BRANCH_UNAVAILABLE", message: "The selected feature branch could not be verified." }, branchResponse.status);
      const existingResponse = await githubRequest("/repos/" + repo + "/contents/" + filePath.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch), token.accessToken);
      const existing = existingResponse.ok ? await readPayload(existingResponse) : {};
      if (existingResponse.ok && (typeof existing["sha"] !== "string" || !expectedSha || existing["sha"] !== expectedSha)) return respond({ error: "FILE_CHANGED", message: "This file changed on GitHub after it was loaded. Reload it before committing to avoid overwriting another change." }, 409);
      if (!existingResponse.ok && existingResponse.status !== 404) return respond({ error: "FILE_READ_FAILED", message: "GitHub could not verify the current file version." }, existingResponse.status);
      if (!existingResponse.ok && expectedSha) return respond({ error: "FILE_CHANGED", message: "This file no longer exists on the selected branch. Reload it before committing." }, 409);
      const bytes = encoder.encode(content);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const putBody: Record<string, unknown> = { message, content: btoa(binary), branch };
      if (typeof existing["sha"] === "string") putBody["sha"] = existing["sha"];
      const response = await githubRequest("/repos/" + repo + "/contents/" + filePath.split("/").map(encodeURIComponent).join("/"), token.accessToken, { method: "PUT", body: JSON.stringify(putBody) });
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "COMMIT_FAILED", message: typeof payload["message"] === "string" ? payload["message"] : "GitHub could not save this file." }, response.status);
      return respond({ ok: true, commit: payload["commit"], content: payload["content"] });
    }
    if (path === "branch" && request.method === "POST") {
      const body = await readBody(request);
      const repo = repoName(body?.["repo"]);
      const name = typeof body?.["name"] === "string" ? body["name"].trim() : "";
      const base = typeof body?.["base"] === "string" ? body["base"].trim().slice(0, 150) : "";
      if (!body || !repo || !/^[A-Za-z0-9._/-]{1,120}$/.test(name) || name.startsWith("/") || name.endsWith("/") || name.includes("..") || !base) return respond({ error: "INVALID_BRANCH", message: "Enter a valid branch name and base branch." }, 400);
      const baseResponse = await githubRequest("/repos/" + repo + "/branches/" + encodeURIComponent(base), token.accessToken);
      const baseData = await readPayload(baseResponse);
      if (!baseResponse.ok || typeof baseData["commit"] !== "object" || !baseData["commit"] || typeof (baseData["commit"] as Record<string, unknown>)["sha"] !== "string") return respond({ error: "BASE_BRANCH_UNAVAILABLE", message: "Could not find the base branch commit." }, 404);
      const sha = (baseData["commit"] as Record<string, unknown>)["sha"] as string;
      const response = await githubRequest("/repos/" + repo + "/git/refs", token.accessToken, { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + name, sha }) });
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "BRANCH_CREATE_FAILED", message: typeof payload["message"] === "string" ? payload["message"] : "Could not create branch." }, response.status);
      return respond({ ok: true, branch: { name, sha } });
    }
    if (path === "pulls" && request.method === "GET") {
      const repo = repoName(url.searchParams.get("repo"));
      if (!repo) return respond({ error: "INVALID_REPOSITORY" }, 400);
      const response = await githubRequest("/repos/" + repo + "/pulls?state=open&per_page=50&sort=updated&direction=desc", token.accessToken);
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "PULL_REQUESTS_FAILED", message: typeof payload["message"] === "string" ? payload["message"] : "Could not load pull requests." }, response.status);
      const items = Array.isArray(payload) ? payload["filter"]((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
      return respond({ ok: true, pullRequests: items.map(item => {
        const head = item["head"] && typeof item["head"] === "object" ? item["head"] as Record<string, unknown> : {};
        const base = item["base"] && typeof item["base"] === "object" ? item["base"] as Record<string, unknown> : {};
        const user = item["user"] && typeof item["user"] === "object" ? item["user"] as Record<string, unknown> : {};
        return { number: item["number"], title: item["title"], state: item["state"], htmlUrl: item["html_url"], head: head["ref"], base: base["ref"], headSha: head["sha"], user: user["login"] };
      }) });
    }
    if (path === "pulls" && request.method === "POST") {
      const body = await readBody(request);
      const repo = repoName(body?.["repo"]);
      const head = typeof body?.["head"] === "string" ? body["head"].trim().slice(0, 150) : "";
      const base = typeof body?.["base"] === "string" ? body["base"].trim().slice(0, 150) : "";
      const title = typeof body?.["title"] === "string" ? body["title"].trim().slice(0, 250) : "";
      const description = typeof body?.["body"] === "string" ? body["body"].slice(0, 10_000) : "";
      if (!body || !repo || !head || !base || !title) return respond({ error: "INVALID_PULL_REQUEST", message: "Repository, title, head branch and base branch are required." }, 400);
      const response = await githubRequest("/repos/" + repo + "/pulls", token.accessToken, { method: "POST", body: JSON.stringify({ title, body: description, head, base }) });
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "PULL_REQUEST_FAILED", message: typeof payload["message"] === "string" ? payload["message"] : "Could not create the pull request." }, response.status);
      return respond({ ok: true, pullRequest: { number: payload["number"], title: payload["title"], htmlUrl: payload["html_url"], state: payload["state"] } });
    }
    if (path === "comment" && request.method === "POST") {
      const body = await readBody(request);
      const repo = repoName(body?.["repo"]);
      const number = Number(body?.["number"]);
      const comment = typeof body?.["comment"] === "string" ? body["comment"].trim().slice(0, 10_000) : "";
      if (!body || !repo || !Number.isInteger(number) || number < 1 || !comment) return respond({ error: "INVALID_COMMENT" }, 400);
      const response = await githubRequest("/repos/" + repo + "/issues/" + number + "/comments", token.accessToken, { method: "POST", body: JSON.stringify({ body: comment }) });
      const payload = await readPayload(response);
      if (!response.ok) return respond({ error: "COMMENT_FAILED", message: typeof payload["message"] === "string" ? payload["message"] : "Could not post the comment." }, response.status);
      return respond({ ok: true, comment: { id: payload["id"], htmlUrl: payload["html_url"] } });
    }
    if (path === "merge" && request.method === "POST") {
      const body = await readBody(request);
      const repo = repoName(body?.["repo"]);
      const number = Number(body?.["number"]);
      const method = ["merge", "squash", "rebase"].includes(String(body?.["method"])) ? String(body?.["method"]) : "squash";
      const expectedHeadSha = typeof body?.["expectedHeadSha"] === "string" ? body["expectedHeadSha"] : "";
      if (!body || !repo || !Number.isInteger(number) || number < 1 || !/^[a-f0-9]{40}$/i.test(expectedHeadSha)) return respond({ error: "INVALID_MERGE", message: "A valid pull request number and expected head SHA are required." }, 400);
      const pullResponse = await githubRequest("/repos/" + repo + "/pulls/" + number, token.accessToken);
      const pull = await readPayload(pullResponse);
      const head = pull["head"] && typeof pull["head"] === "object" ? (pull["head"] as Record<string, unknown>)["sha"] : null;
      if (!pullResponse.ok) return respond({ error: "PULL_REQUEST_UNAVAILABLE", message: "The pull request could not be verified." }, pullResponse.status);
      if (head !== expectedHeadSha) return respond({ error: "PULL_REQUEST_CHANGED", message: "The pull request changed after it was loaded. Refresh the list before merging." }, 409);
      if (pull["state"] !== "open" || pull["draft"] === true || pull["mergeable"] === false) return respond({ error: "PULL_REQUEST_NOT_MERGEABLE", message: "This pull request is closed, draft, or not currently mergeable." }, 409);
      const response = await githubRequest("/repos/" + repo + "/pulls/" + number + "/merge", token.accessToken, { method: "PUT", body: JSON.stringify({ merge_method: method, sha: expectedHeadSha }) });
      const payload = await readPayload(response);
      if (!response.ok || payload["merged"] !== true) return respond({ error: "MERGE_FAILED", message: typeof payload["message"] === "string" ? payload["message"] : "GitHub did not merge this pull request." }, response.status || 409);
      return respond({ ok: true, merged: true, sha: payload["sha"], message: payload["message"] });
    }
    return respond({ error: "NOT_FOUND", message: "Unknown GitHub endpoint." }, 404);
  } catch (error) {
    console.error("[CodeForge GitHub] Request failed", { message: error instanceof Error ? error.message.slice(0, 180) : "Unknown error" });
    return respond({ error: "GITHUB_UNAVAILABLE", message: "GitHub could not complete this request. Please retry." }, 502);
  }
}
