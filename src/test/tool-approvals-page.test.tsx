import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalPageView } from "../routes/tool-approvals/$id";

const approvalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: approvalId,
    label: "Publish Facebook post",
    description: "Publish this text to the selected Page.",
    destructive: false,
    preview: {
      pageId: "page-123",
      message: "Hello from CodeForge",
    },
    status: "pending",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderApprovalPage() {
  const view = render(<ToolApprovalPageView id={approvalId} />);
  return {
    ...view,
    dispose: () => view.unmount(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authenticated approval review page browser flow", () => {
  it("loads owner-approved details with same-origin credentials and safe no-store caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true, approval: approval() }));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      expect(await screen.findByRole("heading", { name: "Publish Facebook post" })).toBeTruthy();
      expect(screen.getByText("Hello from CodeForge")).toBeTruthy();
      expect(screen.getByText("page-123")).toBeTruthy();

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tool-approvals/" + approvalId,
        expect.objectContaining({
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        }),
      );
      expect(screen.getByRole("button", { name: "Approve action" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    } finally {
      page.dispose();
    }
  });

  it("shows a sign-in message and no action controls when the API rejects an unauthenticated session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      error: "AUTH_REQUIRED",
      message: "Sign in to the same Dhwani account that created this approval.",
    }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Sign in to the same Dhwani account that created this approval",
      );
      expect(screen.queryByRole("button", { name: "Approve action" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      page.dispose();
    }
  });

  it("posts an explicit reject decision and disables further actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, approval: approval() }))
      .mockResolvedValueOnce(response({
        ok: true,
        status: "rejected",
        message: "The proposed action was rejected. Nothing was sent to the social platform.",
      }));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "The proposed action was rejected",
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/tool-approvals/" + approvalId + "/reject",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      expect(screen.getByText(/This approval is no longer pending/)).toBeTruthy();
    } finally {
      page.dispose();
    }
  });

  it("posts an explicit approve decision and displays the terminal response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, approval: approval() }))
      .mockResolvedValueOnce(response({
        ok: true,
        status: "executed",
        message: "The connected platform confirmed the action.",
      }));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      fireEvent.click(await screen.findByRole("button", { name: "Approve action" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "The connected platform confirmed the action",
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/tool-approvals/" + approvalId + "/approve",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          body: "{}",
        }),
      );
      expect(screen.queryByRole("button", { name: "Approve action" })).toBeNull();
    } finally {
      page.dispose();
    }
  });

  it("requires a second browser confirmation before sending a destructive approval", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        ok: true,
        approval: approval({
          label: "Delete YouTube video",
          description: "Permanently delete the selected video.",
          destructive: true,
          preview: { videoId: "abcdefghijk", title: "Test video" },
        }),
      }))
      .mockResolvedValueOnce(response({
        ok: true,
        status: "executed",
        message: "The connected platform confirmed the action.",
      }));
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      fireEvent.click(await screen.findByRole("button", { name: "Confirm and approve" }));
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      confirmMock.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Confirm and approve" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/tool-approvals/" + approvalId + "/approve",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          body: JSON.stringify({ confirmDelete: true }),
        }),
      );
    } finally {
      page.dispose();
    }
  });

  it("renders untrusted approval preview values as text and never as HTML", async () => {
    const unsafeTitle = '<img src=x onerror="window.__approvalXss = true">';
    const fetchMock = vi.fn().mockResolvedValue(response({
      ok: true,
      approval: approval({ preview: { title: unsafeTitle } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      expect(await screen.findByText(unsafeTitle)).toBeTruthy();
      expect(document.querySelector("img[src='x']")).toBeNull();
      expect((window as Window & { __approvalXss?: boolean }).__approvalXss).toBeUndefined();
    } finally {
      page.dispose();
    }
  });

  it("hides decision controls when the server marks the platform outcome uncertain", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, approval: approval() }))
      .mockResolvedValueOnce(response({
        ok: false,
        status: "uncertain",
        message: "CodeForge could not verify the platform response. Check your connected account before requesting the action again.",
      }, 502));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      fireEvent.click(await screen.findByRole("button", { name: "Approve action" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Check your connected account");
      expect(screen.queryByRole("button", { name: "Approve action" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      expect(screen.getByText(/This approval is no longer pending/)).toBeTruthy();
    } finally {
      page.dispose();
    }
  });

  it("locks the page after a network failure because the action outcome may be ambiguous", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, approval: approval() }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      fireEvent.click(await screen.findByRole("button", { name: "Approve action" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The outcome could not be verified",
      );
      expect(screen.queryByRole("button", { name: "Approve action" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      expect(screen.getByText(/This approval is no longer pending/)).toBeTruthy();
    } finally {
      page.dispose();
    }
  });

  it("does not show decision controls after the approval expires", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      ok: true,
      approval: approval({
        status: "pending",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const page = renderApprovalPage();

    try {
      expect(await screen.findByText(/This approval is no longer pending/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve action" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    } finally {
      page.dispose();
    }
  });
});
