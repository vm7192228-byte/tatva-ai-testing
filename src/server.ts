import "./lib/error-capture";

import { handleChatApiRequest } from "./lib/chat-api.server";
import { handleMediaApiRequest } from "./lib/media-api.server";
import { handleAuthApiRequest } from "./lib/auth-api.server";
import { handleConversationsApiRequest } from "./lib/conversations-api.server";
import { handleSocialApiRequest } from "./lib/social-api.server";
import { handleGitHubApiRequest } from "./lib/github-api.server";
import { handleBillingApiRequest } from "./lib/billing-api.server";
import { handleChatGenerationsApiRequest } from "./lib/chat-generations.server";
import { handleUploadsApiRequest } from "./lib/uploads-api.server";
import { handleToolApprovalsApiRequest } from "./lib/tool-approvals.server";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const authResponse = await handleAuthApiRequest(request, env);
      if (authResponse) return authResponse;
      const uploadsResponse = await handleUploadsApiRequest(request, env);
      if (uploadsResponse) return uploadsResponse;
      const approvalsResponse = await handleToolApprovalsApiRequest(request, env);
      if (approvalsResponse) return approvalsResponse;
      const socialResponse = await handleSocialApiRequest(request, env);
      if (socialResponse) return socialResponse;
      const githubResponse = await handleGitHubApiRequest(request, env);
      if (githubResponse) return githubResponse;
      const billingResponse = await handleBillingApiRequest(request, env);
      if (billingResponse) return billingResponse;
      const conversationsResponse = await handleConversationsApiRequest(request, env);
      if (conversationsResponse) return conversationsResponse;
      const generationsResponse = await handleChatGenerationsApiRequest(request, env);
      if (generationsResponse) return generationsResponse;
      const mediaResponse = await handleMediaApiRequest(request, env);
      if (mediaResponse) return mediaResponse;
      const apiResponse = await handleChatApiRequest(request, env, ctx);
      if (apiResponse) return apiResponse;
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
