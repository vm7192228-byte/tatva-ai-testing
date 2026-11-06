import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeforgeMarkup } from "../lib/codeforge-markup";

describe("Tatv AI brand and chat shell", () => {
  it("uses the animated Tatv mark as the menu trigger and welcome identity", () => {
    expect(codeforgeMarkup).toContain('id="sidebarToggle"');
    expect(codeforgeMarkup).toContain('tatv-menu-toggle');
    expect(codeforgeMarkup).toContain('aria-label="Open menu"');
    expect(codeforgeMarkup).toContain('src="/tatv/tatv-mark.svg"');
    expect(codeforgeMarkup).toContain("नमस्ते, मैं तत्व हूँ");
    expect(codeforgeMarkup).toContain("Hindi, English ya Hinglish");
    expect(codeforgeMarkup).toContain('tatv-suggestions');
  });

  it("keeps the existing chat, attachment, voice and AI model controls available", () => {
    expect(codeforgeMarkup).toContain('id="chatForm"');
    expect(codeforgeMarkup).toContain('id="promptInput"');
    expect(codeforgeMarkup).toContain('id="plusMenuButton"');
    expect(codeforgeMarkup).toContain('id="plusMenu"');
    expect(codeforgeMarkup).toContain('data-action="upload-media"');
    expect(codeforgeMarkup).toContain('data-action="upload-files"');
    expect(codeforgeMarkup).toContain('id="attachmentInput"');
    expect(codeforgeMarkup).toContain('id="sendButton"');
    expect(codeforgeMarkup).toContain('id="modelChip"');
    expect(codeforgeMarkup).toContain('id="integrationGrid"');
  });

  it("does not expose the previous product brand in the primary app UI", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    const markup = readFileSync(resolve(process.cwd(), "src/lib/codeforge-markup.ts"), "utf8");
    expect(codeforgeMarkup).not.toContain("CodeForge");
    expect(app).not.toContain("CodeForge");
    expect(markup).not.toContain("CodeForge");
  });

  it("ships a well-formed SVG logo that the browser can render", () => {
    const logo = readFileSync(resolve(process.cwd(), "public/tatv/tatv-mark.svg"), "utf8");
    const parsed = new DOMParser().parseFromString(logo, "image/svg+xml");
    expect(parsed.documentElement.localName).toBe("svg");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
  });

  it("ships the supplied triguna-and-bindu logo asset and drawer styling", () => {
    const logo = readFileSync(resolve(process.cwd(), "public/tatv/tatv-mark.svg"), "utf8");
    const styles = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");
    expect(logo).toContain('viewBox="0 0 240 240"');
    expect(logo).toContain('id="bindu"');
    expect(logo).toContain('id="g1"');
    expect(logo).toContain('id="g2"');
    expect(logo).toContain('id="flow"');
    expect(logo).toContain('attributeName="gradientTransform"');
    expect(logo).toContain(".a{animation:spin 9s linear infinite}");
    expect(logo).toContain(".b{animation:spin 14s linear infinite reverse}");
    expect(logo).toContain("@keyframes draw");
    expect(logo).toContain("@keyframes pulse");
    expect(logo).toContain("M74 86 Q120 72 166 86");
    expect(styles).toContain(".sidebar.open");
    expect(styles).toContain(".tatv-menu-toggle");
    expect(styles).toContain(".composer-bottom #promptInput");
    expect(styles).toContain(".topbar-plus-button");
    expect(styles).toContain(".sidebar.open");
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    expect(app).toContain("topbarPlusButton.hidden = view !== 'chat'");
    expect(app).toContain("sidebar.classList.toggle('open', opening)");
  });
});
