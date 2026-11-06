const styles = {
  card: "border:1px solid #d8e4f4;background:#f7faff;border-radius:14px;padding:14px 16px;margin:12px 0;display:grid;gap:9px;color:#1e293b;font:inherit;",
  eyebrow: "font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;",
  heading: "font-size:14px;font-weight:700;color:#0f172a;",
  body: "font-size:13px;line-height:1.55;color:#475569;overflow-wrap:anywhere;",
  button: "display:inline-flex;align-items:center;justify-content:center;background:#2563eb;color:white;text-decoration:none;border-radius:999px;padding:9px 14px;font-size:13px;font-weight:650;width:max-content;",
  warning: "font-size:12px;line-height:1.5;color:#9a3412;background:#fff7ed;border-radius:9px;padding:8px 10px;"
};

function textElement(tag, text, style) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (style) element.setAttribute("style", style);
  return element;
}

function approvalLink(value) {
  if (!value || typeof value !== "object" || typeof value.approvalUrl !== "string") return null;
  try {
    const url = new URL(value.approvalUrl, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/tool-approvals\/[0-9a-f-]{36}$/i.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Adds a safe, owner-reviewed action card to the currently streaming assistant message. */
export function renderToolApprovalCard(container, approval) {
  if (!(container instanceof Element) || !approval || typeof approval !== "object") return false;
  if (typeof approval.id !== "string" || !/^[0-9a-f-]{36}$/i.test(approval.id)) return false;
  const link = approvalLink(approval);
  if (!link) return false;
  const content = container.querySelector(".message-content") || container;
  if ([...content.querySelectorAll(".cf-tool-approval-card")].some(card => card.dataset.toolApprovalId === approval.id)) return true;

  const card = document.createElement("section");
  card.className = "cf-tool-approval-card";
  card.dataset.toolApprovalId = approval.id;
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.setAttribute("style", styles.card);
  card.appendChild(textElement("div", "ACTION REVIEW", styles.eyebrow));
  card.appendChild(textElement("div", typeof approval.label === "string" ? approval.label : "Approval required", styles.heading));
  card.appendChild(textElement(
    "p",
    typeof approval.description === "string" ? approval.description : "Review this proposed action before anything is changed.",
    styles.body
  ));

  const preview = approval.preview && typeof approval.preview === "object" ? approval.preview : {};
  const details = [];
  for (const key of ["title", "message", "privacyStatus", "videoId", "pageId"]) {
    const value = preview[key];
    if (typeof value === "string" && value.trim()) {
      details.push(key === "privacyStatus" ? "Privacy: " + value :
        key === "videoId" ? "Video ID: " + value :
        key === "pageId" ? "Page ID: " + value :
        value);
    }
  }
  if (details.length) {
    const detail = textElement("p", details.join("\n"), styles.body);
    detail.style.whiteSpace = "pre-wrap";
    card.appendChild(detail);
  }
  if (approval.destructive === true) {
    card.appendChild(textElement("p", "This is a destructive action. Dhwani will ask you to confirm again on the review page.", styles.warning));
  } else {
    card.appendChild(textElement("p", "Nothing has been published or changed yet.", styles.body));
  }
  const anchor = document.createElement("a");
  anchor.href = link.pathname;
  anchor.textContent = "Review action";
  anchor.setAttribute("style", styles.button);
  anchor.setAttribute("rel", "noopener");
  card.appendChild(anchor);
  content.appendChild(card);
  return true;
}
