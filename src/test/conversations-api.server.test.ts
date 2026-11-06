import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));

import { handleConversationsApiRequest } from "../lib/conversations-api.server";

const runtimeEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_ANON_KEY: "publishable-test-key",
};

function mutationRequest(
  method: "POST" | "DELETE",
  headers: Record<string, string> = {},
) {
  return new Request("https://codeforge.example/api/conversations", {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    ...(method === "POST" ? {
      body: JSON.stringify({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "A saved chat", messages: [{ role: "user", content: "Hello" }] }),
    } : {}),
  });
}

beforeEach(() => {
  mocks.getAuthenticatedSession.mockResolvedValue({
    configured: false,
    user: null,
    cookies: [],
  });
});

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saved conversation mutation origin protection", () => {
  it.each(["POST", "DELETE"] as const)(
    "rejects %s without Origin or same-origin Fetch Metadata",
    async method => {
      const response = await handleConversationsApiRequest(mutationRequest(method), runtimeEnv);
      const payload = await response?.json();

      expect(response?.status).toBe(403);
      expect(payload).toMatchObject({ error: "ORIGIN_NOT_ALLOWED" });
      expect(mocks.getAuthenticatedSession).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "DELETE"] as const)(
    "rejects cross-origin %s before checking account state",
    async method => {
      const response = await handleConversationsApiRequest(
        mutationRequest(method, { origin: "https://attacker.example" }),
        runtimeEnv,
      );

      expect(response?.status).toBe(403);
      expect(mocks.getAuthenticatedSession).not.toHaveBeenCalled();
    },
  );

  it("allows same-origin Fetch Metadata as a browser fallback when Origin is absent", async () => {
    const response = await handleConversationsApiRequest(
      mutationRequest("POST", { "sec-fetch-site": "same-origin" }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(503);
    expect(payload).toMatchObject({ error: "AUTH_NOT_CONFIGURED" });
    expect(mocks.getAuthenticatedSession).toHaveBeenCalledOnce();
  });

  it("accepts a matching Origin before account authorization", async () => {
    const response = await handleConversationsApiRequest(
      mutationRequest("DELETE", { origin: "https://codeforge.example" }),
      runtimeEnv,
    );

    expect(response?.status).toBe(503);
    expect(mocks.getAuthenticatedSession).toHaveBeenCalledOnce();
  });
});
