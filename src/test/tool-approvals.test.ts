import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
  handleSocialApiRequest: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));
vi.mock("../lib/social-api.server", () => ({
  handleSocialApiRequest: mocks.handleSocialApiRequest,
}));

import { createPendingToolApproval, handleToolApprovalsApiRequest } from "../lib/tool-approvals.server";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const approvalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-service-role-key",
};

function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: approvalId,
    user_id: ownerId,
    tool_name: "youtube_delete_video",
    payload: { videoId: "abcdefghijk" },
    idempotency_key: "generation:tool-call",
    status: "pending",
    result: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    decided_at: null,
    finished_at: null,
    ...overrides,
  };
}

function createRestMock(initial = pendingApproval()) {
  let row: Record<string, unknown> | null = initial;
  const calls: Array<{ method: string; url: URL; body?: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });

    if (method === "GET") {
      const userFilter = url.searchParams.get("user_id");
      const idFilter = url.searchParams.get("id");
      const matches = row &&
        userFilter === "eq." + String(row["user_id"]) &&
        idFilter === "eq." + String(row["id"]);
      return new Response(JSON.stringify(matches ? [row] : []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "PATCH") {
      const statusFilter = url.searchParams.get("status");
      const userFilter = url.searchParams.get("user_id");
      const idFilter = url.searchParams.get("id");
      const matches = row &&
        userFilter === "eq." + String(row["user_id"]) &&
        idFilter === "eq." + String(row["id"]) &&
        statusFilter === "eq." + String(row["status"]);
      const expiryFilter = url.searchParams.get("expires_at");
      const expiryMatches = !expiryFilter ||
        (String(expiryFilter).startsWith("gt.") &&
          Date.parse(String(row?.["expires_at"])) > Date.parse(String(expiryFilter).slice(3)));
      if (!matches || !expiryMatches || !row) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      row = { ...row, ...(body ?? {}) };
      return new Response(JSON.stringify([row]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Unsupported test method", { status: 405 });
  });
  return {
    fetchMock,
    calls,
    get row() { return row; },
  };
}

function approvalRequest(
  action: "approve" | "reject",
  body: Record<string, unknown> = {},
) {
  return new Request("https://app.example/api/tool-approvals/" + approvalId + "/" + action, {
    method: "POST",
    headers: {
      origin: "https://app.example",
      cookie: "cf_access=test-session",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  mocks.handleSocialApiRequest.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("owner-scoped tool action approvals", () => {
  it("rejects unsupported URL schemes even when the approval host is localhost", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createPendingToolApproval(
      runtimeEnv,
      ownerId,
      "generation:ftp-localhost",
      "facebook_publish_post",
      { pageId: "page-123", message: "A proposed post." },
      "ftp://localhost",
    )).rejects.toThrow("INVALID_TOOL_APPROVAL_ORIGIN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not read or mutate approvals for signed-out requests", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: null,
      cookies: [],
    });
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("approve", { confirmDelete: true }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(401);
    expect(payload.error).toBe("AUTH_REQUIRED");
    expect(database.fetchMock).not.toHaveBeenCalled();
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("does not disclose another account's approval record", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: otherUserId },
      cookies: [],
    });
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const request = new Request("https://app.example/api/tool-approvals/" + approvalId, {
      method: "GET",
      headers: { cookie: "cf_access=other-account" },
    });
    const response = await handleToolApprovalsApiRequest(request, runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(404);
    expect(payload.error).toBe("APPROVAL_NOT_FOUND");
    expect(database.calls[0]?.url.searchParams.get("user_id")).toBe("eq." + otherUserId);
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("rejects cross-origin decisions before making a database change", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const request = new Request("https://app.example/api/tool-approvals/" + approvalId + "/reject", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        cookie: "cf_access=test-session",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const response = await handleToolApprovalsApiRequest(request, runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(403);
    expect(payload.error).toBe("ORIGIN_NOT_ALLOWED");
    expect(database.calls).toHaveLength(0);
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("requires a second explicit confirmation before deleting a YouTube video", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("approve"),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(400);
    expect(payload.error).toBe("EXPLICIT_CONFIRMATION_REQUIRED");
    expect(database.calls.filter(call => call.method === "PATCH")).toHaveLength(0);
    expect(database.row?.["status"]).toBe("pending");
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("executes an approved action once and persists terminal state", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [
        "cf_access=rotated-access-token; Path=/; HttpOnly; SameSite=Lax",
        "cf_refresh=rotated-refresh-token; Path=/; HttpOnly; SameSite=Lax",
      ],
    });
    mocks.handleSocialApiRequest.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      id: "youtube-result-123",
      message: "The action was accepted.",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("approve", { confirmDelete: true }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, status: "executed" });
    expect(mocks.handleSocialApiRequest).toHaveBeenCalledTimes(1);
    const socialRequest = mocks.handleSocialApiRequest.mock.calls[0]?.[0] as Request;
    expect(new URL(socialRequest.url).pathname).toBe("/api/social/youtube/video-delete");
    expect(socialRequest.headers.get("cookie")).toContain("cf_access=rotated-access-token");
    expect(socialRequest.headers.get("cookie")).toContain("cf_refresh=rotated-refresh-token");
    expect(socialRequest.headers.get("cookie")).not.toContain("test-session");
    expect(await socialRequest.json()).toEqual({ videoId: "abcdefghijk" });
    expect(database.calls.filter(call => call.method === "PATCH").map(call => call.body?.["status"]))
      .toEqual(["executing", "executed"]);
    expect(database.row?.["status"]).toBe("executed");
  });

  it("does not mark a malformed 2xx platform response as executed", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    mocks.handleSocialApiRequest.mockResolvedValue(new Response("accepted but unparseable", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("approve", { confirmDelete: true }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(502);
    expect(payload).toMatchObject({ ok: false, status: "uncertain" });
    expect(database.row?.["status"]).toBe("uncertain");
    expect(database.row?.["result"]).toMatchObject({
      message: "The platform response is uncertain. Check the connected account before trying again.",
    });
    expect(mocks.handleSocialApiRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a pending action without calling the social provider", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("reject"),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, status: "rejected" });
    expect(database.row?.["status"]).toBe("rejected");
    expect(database.calls.filter(call => call.method === "PATCH").map(call => call.body?.["status"]))
      .toEqual(["rejected"]);
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("expires a pending action and refuses to execute it", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock(pendingApproval({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("approve", { confirmDelete: true }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(410);
    expect(payload).toMatchObject({ error: "APPROVAL_EXPIRED", status: "expired" });
    expect(database.row?.["status"]).toBe("expired");
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("converts a stale executing approval to uncertain without replaying the action", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock(pendingApproval({
      status: "executing",
      updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
      decided_at: new Date(Date.now() - 6 * 60_000).toISOString(),
    }));
    vi.stubGlobal("fetch", database.fetchMock);

    const request = new Request("https://app.example/api/tool-approvals/" + approvalId, {
      method: "GET",
      headers: { cookie: "cf_access=test-session" },
    });
    const response = await handleToolApprovalsApiRequest(request, runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload.approval.status).toBe("uncertain");
    expect(payload.approval.result.message).toContain("Check the connected platform");
    expect(database.row?.["status"]).toBe("uncertain");
    expect(database.calls.filter(call => call.method === "PATCH").map(call => call.body?.["status"]))
      .toEqual(["uncertain"]);
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });

  it("leaves a recent executing approval alone while its original request may still be running", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock(pendingApproval({
      status: "executing",
      updated_at: new Date(Date.now() - 30_000).toISOString(),
    }));
    vi.stubGlobal("fetch", database.fetchMock);

    const request = new Request("https://app.example/api/tool-approvals/" + approvalId, {
      method: "GET",
      headers: { cookie: "cf_access=test-session" },
    });
    const response = await handleToolApprovalsApiRequest(request, runtimeEnv);
    const payload = await response?.json();

    expect(response?.status).toBe(200);
    expect(payload.approval.status).toBe("executing");
    expect(database.calls.filter(call => call.method === "PATCH")).toHaveLength(0);
    expect(database.row?.["status"]).toBe("executing");
  });

  it("allows only one concurrent request to claim and execute the same approval", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    mocks.handleSocialApiRequest.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      id: "youtube-result-123",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const database = createRestMock();
    vi.stubGlobal("fetch", database.fetchMock);

    const [first, second] = await Promise.all([
      handleToolApprovalsApiRequest(approvalRequest("approve", { confirmDelete: true }), runtimeEnv),
      handleToolApprovalsApiRequest(approvalRequest("approve", { confirmDelete: true }), runtimeEnv),
    ]);
    expect([first?.status, second?.status].sort()).toEqual([200, 409]);
    expect(mocks.handleSocialApiRequest).toHaveBeenCalledTimes(1);
    const patches = database.calls.filter(call => call.method === "PATCH");
    expect(patches.filter(call => call.body?.["status"] === "executing")).toHaveLength(2);
    expect(patches[patches.length - 1]?.body?.["status"]).toBe("executed");
    expect(database.row?.["status"]).toBe("executed");
  });

  it("cannot run an approval that has already been resolved", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({
      configured: true,
      user: { id: ownerId },
      cookies: [],
    });
    const database = createRestMock(pendingApproval({ status: "executed" }));
    vi.stubGlobal("fetch", database.fetchMock);

    const response = await handleToolApprovalsApiRequest(
      approvalRequest("approve", { confirmDelete: true }),
      runtimeEnv,
    );
    const payload = await response?.json();

    expect(response?.status).toBe(409);
    expect(payload.error).toBe("APPROVAL_ALREADY_RESOLVED");
    expect(database.calls.filter(call => call.method === "PATCH")).toHaveLength(0);
    expect(mocks.handleSocialApiRequest).not.toHaveBeenCalled();
  });
});
