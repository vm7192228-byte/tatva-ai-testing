import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
const indexSource = readFileSync(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");

describe("KIE video studio browser integration", () => {
  it("opens the studio from the video tool and quick action", () => {
    expect(appSource).toContain('if (kind === "video")');
    expect(appSource).toContain('openWanVideoStudio();');
    expect(appSource).toContain("__open_wan_video__");
  });

  it("routes approved composer video requests into the existing KIE studio instead of the retired media endpoint", () => {
    const routeIndex = appSource.indexOf('if (mediaIntent === "video")');
    const oldEndpointIndex = appSource.indexOf('const endpoint = mediaIntent ? "/api/media" : "/api/chat";', routeIndex);
    expect(routeIndex).toBeGreaterThan(-1);
    expect(oldEndpointIndex).toBeGreaterThan(routeIndex);
    expect(appSource.slice(routeIndex, oldEndpointIndex)).toContain("openWanVideoStudio(clean, Boolean(currentUser))");
  });

  it("prefills the video studio and auto-submits only after the prior user confirmation", () => {
    expect(appSource).toContain("function openWanVideoStudio(initialPrompt = \"\", autoSubmit = false)");
    expect(appSource).toContain('promptField.value = initialPrompt;');
    expect(appSource).toContain("if (autoSubmit && currentUser && form)");
    expect(appSource).toContain("form.requestSubmit();");
    expect(appSource).toContain("This video brief is longer than the 1,800-character limit");
  });

  it("uses the authenticated same-origin video API and server idempotency key", () => {
    expect(appSource).toContain('fetch("/api/video", {');
    expect(appSource).toContain('credentials: "same-origin"');
    expect(appSource).toContain('"idempotency-key": pendingKieVideoIdempotencyKey');
    expect(appSource).toContain('fetch("/api/video?jobId=" + encodeURIComponent(jobId)');
    expect(appSource).toContain('fetch("/api/video?history=1"');
    expect(appSource).toContain("Automatic checks are paused to avoid unnecessary requests");
    expect(appSource).toContain('data-kie-history-job');
  });

  it("bounds automatic status checks and stops polling when the modal closes", () => {
    expect(appSource).toContain("kieVideoPollCount >= 120");
    expect(appSource).toContain("function stopKieVideoPolling()");
    expect(appSource).toContain('if (typeof stopKieVideoPolling === "function") stopKieVideoPolling();');
  });

  it("respects the server-provided status-poll retry delay", () => {
    expect(appSource).toContain("const retryAfterSeconds = Number(result.retryAfterSeconds);");
    expect(appSource).toContain("Math.min(60_000, Math.ceil(retryAfterSeconds) * 1_000)");
  });

  it("loads the existing video studio stylesheet", () => {
    expect(indexSource).toContain('/codeforge/video-studio.css');
  });
});
