import { afterEach, describe, expect, it } from "vitest";
import { renderToolApprovalCard } from "../../public/codeforge/tool-approvals-ui";

const approvalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function cardHost() {
  const host = document.createElement("article");
  host.innerHTML = '<div class="message-content"></div>';
  document.body.appendChild(host);
  return host;
}

function validApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: approvalId,
    label: "Publish Facebook post",
    description: "Review the exact content before it is sent.",
    destructive: false,
    preview: {
      pageId: "page-123",
      message: "A safe preview",
    },
    approvalUrl: window.location.origin + "/tool-approvals/" + approvalId,
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat approval card browser rendering", () => {
  it("adds a same-origin review link inside the assistant message", () => {
    const host = cardHost();

    expect(renderToolApprovalCard(host, validApproval())).toBe(true);
    const card = host.querySelector(".cf-tool-approval-card");
    const link = card?.querySelector("a");

    expect(card).toBeTruthy();
    expect(card?.getAttribute("role")).toBe("status");
    expect(link?.getAttribute("href")).toBe("/tool-approvals/" + approvalId);
    expect(link?.textContent).toBe("Review action");
    expect(card?.textContent).toContain("A safe preview");
    expect(card?.textContent).toContain("Nothing has been published or changed yet.");
  });

  it("rejects approval links that point to another origin", () => {
    const host = cardHost();

    expect(renderToolApprovalCard(host, validApproval({
      approvalUrl: "https://attacker.example/tool-approvals/" + approvalId,
    }))).toBe(false);
    expect(host.querySelector(".cf-tool-approval-card")).toBeNull();
  });

  it("rejects malformed approval identifiers and paths", () => {
    const host = cardHost();

    expect(renderToolApprovalCard(host, validApproval({ id: "not-a-uuid" }))).toBe(false);
    expect(renderToolApprovalCard(host, validApproval({
      approvalUrl: "https://app.example/settings",
    }))).toBe(false);
    expect(host.querySelector(".cf-tool-approval-card")).toBeNull();
  });

  it("renders untrusted model and user text as text and deduplicates repeated events", () => {
    const host = cardHost();
    const unsafe = '<img src=x onerror="window.__approvalCardXss = true">';
    const data = validApproval({ label: unsafe, description: unsafe, preview: { message: unsafe } });

    expect(renderToolApprovalCard(host, data)).toBe(true);
    expect(renderToolApprovalCard(host, data)).toBe(true);

    const card = host.querySelector(".cf-tool-approval-card");
    expect(card?.textContent).toContain(unsafe);
    expect(card?.querySelector("img")).toBeNull();
    expect(host.querySelectorAll(".cf-tool-approval-card")).toHaveLength(1);
    expect((window as Window & { __approvalCardXss?: boolean }).__approvalCardXss).toBeUndefined();
  });

  it("marks delete proposals as destructive without executing them", () => {
    const host = cardHost();

    expect(renderToolApprovalCard(host, validApproval({
      label: "Delete YouTube video",
      destructive: true,
      preview: { videoId: "abcdefghijk" },
    }))).toBe(true);
    const card = host.querySelector(".cf-tool-approval-card");
    expect(card?.textContent).toContain("This is a destructive action");
    expect(card?.querySelectorAll("button")).toHaveLength(0);
    expect(card?.querySelector("a")?.getAttribute("href")).toBe("/tool-approvals/" + approvalId);
  });
});
