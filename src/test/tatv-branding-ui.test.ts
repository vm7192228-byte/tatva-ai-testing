import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { codeforgeMarkup } from "@/lib/codeforge-markup";

describe("Dhwani AI visual identity", () => {
  it("uses the Dhwani mark as the navigation control and opens the shared drawer", () => {
    expect(codeforgeMarkup).toContain('id="sidebarToggle"');
    expect(codeforgeMarkup).toContain('dhwani-menu-toggle');
    expect(codeforgeMarkup).toContain('src="/dhwani/dhwani-mark.svg"');
    expect(codeforgeMarkup).toContain('id="sidebar"');
    expect(codeforgeMarkup).toContain('id="sidebarOverlay"');
    expect(codeforgeMarkup).not.toContain('id="sidebarToggle" aria-label="Open navigation menu">☰');
  });

  it("keeps the welcome view and message composer clean and connected to the existing chat controls", () => {
    expect(codeforgeMarkup).toContain("नमस्ते, मैं तत्व हूँ");
    expect(codeforgeMarkup).toContain("Hindi, English ya Hinglish");
    expect(codeforgeMarkup).toContain('id="promptInput"');
    expect(codeforgeMarkup).toContain('id="plusMenuButton"');
    expect(codeforgeMarkup).toContain('id="plusMenu"');
    expect(codeforgeMarkup).toContain('data-action="upload-media"');
    expect(codeforgeMarkup).toContain('data-action="upload-files"');
    expect(codeforgeMarkup).toContain('id="sendButton"');
    expect(codeforgeMarkup).toContain("topbar-plus-button");
    expect(codeforgeMarkup).not.toContain("composer-tools");
  });

  it("uses Dhwani typing dots and animated chat bubbles instead of a live progress checklist", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    expect(app).toContain("cf-typing-indicator");
    expect(app).toContain("message-avatar");
    expect(app).toContain("pending-stop-button");
    expect(app).not.toContain("cf-chat-progress");
    expect(css).toContain(".message-arrival");
    expect(css).toContain(".pending-typing");
    expect(css).toContain("dhwani-answer-arrive");
    expect(codeforgeMarkup).toContain('id="messages" class="messages"');
    expect(codeforgeMarkup.indexOf('id="messages"')).toBeLessThan(codeforgeMarkup.indexOf('class="composer-zone"'));
  });

  it("gives desktop a separate full-width workspace and larger chat composition", () => {
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    expect(css).toContain("@media (min-width: 1100px)");
    expect(css).toContain("width: 100vw !important");
    expect(css).toContain("#chatView.has-messages #messages");
    expect(css).toContain("font-size: clamp(46px, 3.7vw, 64px)");
    expect(css).toContain("width: min(1040px, calc(100% - clamp(96px, 12vw, 184px)))");
    expect(css).toContain("@media (min-width: 1600px)");
    expect(css).toContain("@media(max-width:720px)");
  });

  it("keeps desktop suggestions above a compact, naturally-flowing composer", () => {
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    expect(css).toContain("#chatView:not(.has-messages) {");
    expect(css).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    expect(css).toContain("position: relative !important;");
    expect(css).toContain("min-height: 38px;");
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
  });

  it("keeps the desktop sidebar docked on the left and expands the main workspace", () => {
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const desktopStart = css.lastIndexOf("/* Desktop-native workspace: dock the navigation");
    const desktop = css.slice(desktopStart);

    expect(desktopStart).toBeGreaterThan(-1);
    expect(desktop).toContain("@media (min-width: 1100px)");
    expect(desktop).toMatch(/\.sidebar\s*\{[^}]*position:\s*relative !important/s);
    expect(desktop).toMatch(/\.sidebar\s*\{[^}]*inset:\s*auto !important/s);
    expect(desktop).toMatch(/\.sidebar\s*\{[^}]*width:\s*280px !important/s);
    expect(desktop).toContain(".app-shell.sidebar-collapsed .sidebar");
    expect(desktop).toContain("display: none !important");
    expect(desktop).toContain(".main-area");
    expect(desktop).toContain("flex: 1 1 0 !important");

    expect(app).toContain('window.matchMedia("(min-width: 1100px)")');
    expect(app).toContain("function syncSidebarForViewport()");
    expect(app).toContain('shell?.classList.toggle("sidebar-collapsed")');
    expect(app).toContain("if (isDesktopSidebarViewport()) return;");

    const mobileRules = css.slice(0, desktopStart);
    expect(mobileRules).toContain("@media (max-width: 760px)");
    expect(mobileRules).toContain("width: 100vw !important");
  });

  it("does not render the previous product name in the customer-facing app shell", () => {
    expect(codeforgeMarkup).toContain("Dhwani AI");
    expect(codeforgeMarkup).not.toContain("Tatv AI");
    expect(codeforgeMarkup).not.toContain("/tatv/");
    expect(codeforgeMarkup).not.toContain("CodeForge");
  });

  it("ships the animated three-lines-and-bindu mark and Dhwani chat styles", () => {
    const svg = readFileSync(resolve(process.cwd(), "public/tatv/tatv-mark.svg"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    expect(svg).toContain("तीन");
    expect(svg).toContain('M74 86 Q120 72 166 86');
    expect(svg).toContain('M74 106 Q120 92 166 106');
    expect(svg).toContain('M74 126 Q120 112 166 126');
    expect(svg).toContain('animateTransform');
    expect(css).toContain(".dhwani-menu-toggle");
    expect(css).toContain(".dhwani-suggestions");
    expect(css).toContain(".composer-bottom #promptInput");
    expect(css).toContain(".sidebar.open");
  });
  it("shows exactly three branded Dhwani modes and no upstream provider choices", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const providerStart = app.indexOf("const providers = [");
    const providerEnd = app.indexOf("\n];", providerStart);
    expect(providerStart).toBeGreaterThanOrEqual(0);
    expect(providerEnd).toBeGreaterThan(providerStart);
    const providerOptions = app.slice(providerStart, providerEnd);
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    expect(css).toContain(".platform-mark.dhwani");
    expect(providerOptions).toContain('id: "tatv-flash", name: "Dhwani Flash"');
    expect(providerOptions).toContain('id: "tatv-smart", name: "Dhwani Smart"');
    expect(providerOptions).toContain('id: "tatv-ultra", name: "Dhwani Ultra"');
    expect(providerOptions).not.toContain("Gemini");
    expect(providerOptions).not.toContain("Claude");
    expect(providerOptions).not.toContain("OpenAI");
    expect(providerOptions).not.toContain("FreeLLMAPI");
    expect(app).toContain("function chatModeForModel(name)");
    expect(app).toContain("provider: requestedProvider");
    expect(app).toContain("chatMode: chatModeForModel(activeModel)");
    expect(app).toContain("AI video generation — 3 credits/month");
    expect(app).toContain("AI video generation — 24 credits/month");
    expect(app).not.toContain("15 credits/month");
    expect(app).not.toContain("100 credits/month");
    expect(app).toContain("Boolean(aiProviderStatus.codeforgeGateway)");
    expect(codeforgeMarkup).toContain("Inline image, audio and video analysis is disabled");
  });
  it("keeps the primary sidebar limited to New Chat, Code, Projects and Library", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const sidebarStart = codeforgeMarkup.indexOf('<nav class="side-nav"');
    const sidebarEnd = codeforgeMarkup.indexOf("</nav>", sidebarStart);
    const sidebarNav = codeforgeMarkup.slice(sidebarStart, sidebarEnd);

    expect(sidebarStart).toBeGreaterThanOrEqual(0);
    expect(sidebarNav).toContain('data-sidebar-action="code"');
    expect(sidebarNav).toContain('data-sidebar-action="project"');
    expect(sidebarNav).toContain('data-view="library"');
    expect(sidebarNav).not.toContain('data-view="connections"');
    expect(sidebarNav).not.toContain('data-view="models"');
    expect(sidebarNav).not.toContain('data-view="settings"');
    expect(codeforgeMarkup).toContain('id="newChat"');
    expect(codeforgeMarkup).toContain('data-profile-menu="back"');
    expect(app).not.toContain("const workspaceNav = document.querySelector('.side-nav')");
    expect(app).toContain('sidebar.classList.toggle("profile-menu-open", profileMenuOpen)');
  });

  it("keeps Integration cards visible when connection status endpoints are unavailable", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "public/codeforge/dhwani-theme.css"), "utf8");
    expect(app).toContain("const unknownItems = integrations.filter(item => !statusFor(item));");
    expect(app).toContain('data-retry-integrations');
    expect(app).toContain('data-connect="' + "' + item.id + '" + '"');
    expect(css).toContain("#connectionsView .connector-row-list");
    expect(css).toContain(".sidebar.profile-menu-open > .profile-menu-panel:not([hidden])");
  });

  it("declares the YouTube upload fetch response inside the module callback", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    expect(app).toContain('const response = await fetch(endpoint, { method: "POST", credentials: "same-origin"');
    expect(app).not.toContain('        response = await fetch(endpoint, { method: "POST"');
  });
  it("uses signed resumable TUS uploads for large files instead of sending file bytes through Vercel", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const tus = readFileSync(resolve(process.cwd(), "public/codeforge/tus-upload.js"), "utf8");
    expect(app).toContain('import { uploadResumableTus } from "./tus-upload.js"');
    expect(app).toContain("await uploadResumableTus(");
    expect(app).toContain("remove.disabled = attachmentUploadInProgress;");
    expect(app).toContain("if (attachmentUploadInProgress) renderAttachmentTray();");
    expect(app).toContain("if (pendingUploads.length) renderAttachmentTray();");
    expect(tus).toContain('"Tus-Resumable": "1.0.0"');
    expect(tus).toContain('"x-signature": token');
    expect(tus).toContain('"Content-Type": "application/offset+octet-stream"');
    expect(tus).toContain('method: "PATCH"');
    expect(tus).toContain("const chunkSize = 6 * 1024 * 1024");
    expect(tus).toContain('method: "HEAD"');
    expect(app).toContain('fetch("/api/uploads"');
    expect(app).not.toContain('fetch("/api/uploads" +');
  });

  it("persists one Cashfree idempotency key across page reloads and clears it after verification", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    expect(app).toContain('"tatv.cashfree.checkout.v1:"');
    expect(app).toContain("sessionStorage.getItem(checkoutStorageKey)");
    expect(app).toContain("sessionStorage.setItem(checkoutStorageKey");
    expect(app).toContain("button.dataset.checkoutIdempotencyKey");
    expect(app).toContain("button.dataset.checkoutFingerprint");
    expect(app).toContain('"Idempotency-Key": checkoutKey');
    expect(app).toContain('order.error === "CHECKOUT_ALREADY_PROCESSED"');
    expect(app).toContain("attempt?.orderId === orderId");
  });

});
