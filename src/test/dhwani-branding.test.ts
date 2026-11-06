import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeforgeMarkup } from "../lib/codeforge-markup";

describe("Dhwani AI brand and chat shell", () => {
  it("uses the Dhwani sound-wave mark as the menu trigger and welcome identity", () => {
    expect(codeforgeMarkup).toContain('id="sidebarToggle"');
    expect(codeforgeMarkup).toContain("dhwani-menu-toggle");
    expect(codeforgeMarkup).toContain('aria-label="Open menu"');
    expect(codeforgeMarkup).toContain('src="/dhwani/dhwani-mark.svg"');
    expect(codeforgeMarkup).toContain("Dhwani AI");
    expect(codeforgeMarkup).toContain("What's on the agenda today?");
    expect(codeforgeMarkup).toContain('placeholder="How can I help you today?"');
    expect(codeforgeMarkup).toContain("hero-brand-mark");
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

  it("does not expose the retired Tatv or CodeForge brands in the customer-facing app", () => {
    const app = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
    expect(codeforgeMarkup).not.toContain("Tatv AI");
    expect(codeforgeMarkup).not.toContain("/tatv/");
    expect(app).not.toContain("/tatv/");
    expect(app).not.toContain("TATV STUDIO");
    expect(app).not.toContain("TATV CREATOR MOMENT");
    expect(app).not.toContain("CodeForge");
  });

  it("ships a valid Dhwani sound-wave SVG and uses it for the app brand", () => {
    const logo = readFileSync(resolve(process.cwd(), "public/dhwani/dhwani-mark.svg"), "utf8");
    const parsed = new DOMParser().parseFromString(logo, "image/svg+xml");
    const styles = readFileSync(resolve(process.cwd(), "public/codeforge/styles.css"), "utf8");

    expect(parsed.documentElement.localName).toBe("svg");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(logo).toContain('viewBox="0 0 48 48"');
    expect(logo).toContain("Dhwani AI sound wave");
    expect(logo).toContain('<rect x="22" y="5" width="5" height="38" rx="2.5"/>');
    expect(styles).toContain(".dhwani-menu-toggle");
    expect(styles).toContain(".dhwani-suggestions");
    expect(styles).toContain(".sidebar.open");
  });
});
