import { test, expect } from "@playwright/test";

const TEST_USER = {
  id: "alpha-test-user",
  email: "alpha@example.test",
  displayName: "Alpha Tester",
  age: 17,
};

async function installApiMocks(page, { authUnavailable = false, signedOut = false } = {}) {
  const chatRequests = [];
  const transcriptionRequests = [];

  await page.route("https://fonts.googleapis.com/**", route =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" })
  );
  await page.route("https://fonts.gstatic.com/**", route =>
    route.fulfill({ status: 200, body: "" })
  );
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (path === "/api/auth/me" && method === "GET") {
      return authUnavailable
        ? json({ ok: false, error: "AUTH_UNAVAILABLE", message: "Authentication is temporarily unavailable." }, 503)
        : json({ ok: true, user: signedOut ? null : TEST_USER });
    }
    if (path === "/api/chat" && method === "GET") {
      return json({
        ok: true,
        providers: {
          codeforgeGateway: true,
          cloudflare: false,
          pollinations: false,
          openai: false,
          anthropic: false,
          deepseek: false,
          xai: false,
        },
      });
    }
    if (path === "/api/chat" && method === "POST") {
      try { chatRequests.push(JSON.parse(request.postData() || "{}")); } catch { chatRequests.push({}); }
      if (signedOut) {
        return json({ reply: "Dhwani AI test reply received.", model: "Dhwani Smart", route: "freellmapi" });
      }
      return json({ reply: "Dhwani AI test reply received.", model: "Dhwani Smart" });
    }
    if (path === "/api/chat/generations" && method === "POST") {
      return json({ ok: false, message: "Durable generation storage is unavailable in this isolated browser test." }, 503);
    }
    if (path === "/api/transcribe" && method === "POST") {
      transcriptionRequests.push({ contentType: request.headers()["content-type"] || "" });
      return json({ ok: true, text: "Hello Dhwani, this is a voice test." });
    }
    if (path === "/api/billing/status") {
      return json({ ok: true, paid: false, planCode: "free", expiresAt: null });
    }
    if (path === "/api/billing/usage") {
      return json({
        ok: true,
        planCode: "free",
        video: { mode: "coming-soon", limit: 0, remaining: 0 },
        photo: { limit: 2, remaining: 2 },
        fileAnalysis: { limit: 3, remaining: 3 },
        socialAnalysis: { limit: 3, remaining: 3 },
        socialEdit: { limit: 1, remaining: 1 },
        aiChat: { limit: 10, remaining: 10 },
      });
    }
    if (path === "/api/conversations" && method === "GET") {
      return json({ ok: true, conversations: [] });
    }
    if (path === "/api/conversations" && method !== "GET") {
      return json({ ok: true });
    }
    if (path === "/api/social/status") {
      return json({
        youtube: { configured: false, connected: false },
        instagram: { configured: false, connected: false },
        facebook: { configured: false, connected: false },
        publicYouTubeSearchEnabled: true,
      });
    }
    if (path === "/api/github/status") {
      return json({ ok: true, configured: false, connected: false });
    }
    if (path === "/api/auth/logout" || path === "/api/auth/session") {
      return json({ ok: true });
    }
    return json({ ok: true });
  });

  return { chatRequests, transcriptionRequests };
}

async function continueAsGuest(page) {
  await expect(page.locator("#modalBackdrop")).toBeVisible();
  const guestButton = page.getByRole("button", { name: "Continue as guest" });
  await expect(guestButton).toBeDisabled();
  await page.locator("#cfAuthConsent").check();
  await expect(guestButton).toBeEnabled();
  await guestButton.click();
  await expect(page.locator("#modalBackdrop")).toBeHidden();
}

async function installFakeVoiceRuntime(page) {
  await page.addInitScript(() => {
    const voices = [
      { name: "Google Hindi Male", lang: "hi-IN", voiceURI: "test-hi-male", default: true, localService: true },
      { name: "Google Hindi Female", lang: "hi-IN", voiceURI: "test-hi-female", default: false, localService: true },
      { name: "Google English Male", lang: "en-IN", voiceURI: "test-en-male", default: false, localService: true },
      { name: "Google English Female", lang: "en-IN", voiceURI: "test-en-female", default: false, localService: true },
    ];

    window.__playedVoiceUtterances = [];
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class {
        constructor(text) { this.text = text; }
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        getVoices: () => voices,
        cancel() {},
        resume() {},
        addEventListener() {},
        speak(utterance) {
          window.__playedVoiceUtterances.push(String(utterance?.text || ""));
          window.setTimeout(() => {
            utterance.onstart?.();
            utterance.onend?.();
          }, 0);
        },
      },
    });

    class FakeNode {
      connect() {}
      disconnect() {}
    }
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      async resume() {}
      async close() { this.state = "closed"; }
      createMediaStreamSource() { return new FakeNode(); }
      createGain() {
        return {
          gain: {
            value: 1,
            cancelScheduledValues() {},
            setTargetAtTime() {},
          },
          connect() {},
          disconnect() {},
        };
      }
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [] } };
      }
      createAnalyser() {
        return {
          fftSize: 1024,
          getByteTimeDomainData(samples) {
            samples.fill(window.__voiceTestAudioActive ? 160 : 128);
          },
          disconnect() {},
        };
      }
    }
    class FakeMediaRecorder extends EventTarget {
      state = "inactive";
      mimeType = "audio/webm;codecs=opus";
      static isTypeSupported() { return true; }
      start() { this.state = "recording"; }
      stop() {
        if (this.state !== "recording") return;
        const dataEvent = new Event("dataavailable");
        Object.defineProperty(dataEvent, "data", {
          value: new Blob(["simulated voice audio"], { type: "audio/webm" }),
        });
        this.dispatchEvent(dataEvent);
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }

    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    window.__getUserMediaCalls = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.__getUserMediaCalls += 1;
          return {
            active: true,
            getTracks: () => [{ stop() {} }],
          };
        },
      },
    });
    window.__voiceTestAudioActive = false;
  });
}

test.describe("Dhwani AI private-alpha browser smoke", () => {
  test("loads the workspace shell and accessible chat/voice controls", async ({ page }) => {
    await installApiMocks(page);
    await page.goto("/");
    await expect(page.locator(".brand-wordmark")).toContainText("Dhwani AI");
    await expect(page.locator("#promptInput")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dictate a message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start voice conversation" })).toBeVisible();
  });

  test("sends a signed-in user's chat and renders the assistant response", async ({ page }) => {
    const { chatRequests } = await installApiMocks(page);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("/");
    // Wait for app.js to finish installing controls and resolving the mocked session.
    // A detached login button is also "hidden", so it is not a sufficient readiness signal.
    await expect(page.locator("#voiceChatButton")).toBeVisible();
    await expect(page.locator(".profile-button")).toContainText("Alpha Tester");
    await page.locator("#promptInput").fill("Test the private alpha chat path.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => chatRequests.length, { timeout: 20_000 }).toBe(1);
    await expect(page.locator("#messages")).toContainText("Dhwani AI test reply received.", { timeout: 20_000 });
    expect(pageErrors).toEqual([]);
  });

  test("keeps an Auth 503 as an unavailable state rather than issuing logout", async ({ page }) => {
    await installApiMocks(page, { authUnavailable: true });
    const logoutRequests = [];
    page.on("request", request => {
      if (request.url().includes("/api/auth/logout")) logoutRequests.push(request.url());
    });
    await page.goto("/");
    await expect(page.locator("#toast")).toContainText("session has not been cleared", { timeout: 10_000 });
    await expect(page.locator("#modalBackdrop")).toBeHidden();
    expect(logoutRequests).toHaveLength(0);
  });

  test("starts and stops the persistent voice session without reopening its microphone", async ({ page }) => {
    await installApiMocks(page, { signedOut: true });
    await installFakeVoiceRuntime(page);
    await page.goto("/");
    await continueAsGuest(page);
    await page.getByRole("button", { name: "Start voice conversation" }).click();
    await expect(page.getByRole("dialog", { name: "Choose Your Voice" })).toBeVisible();
    await expect(page.locator(".cf-voice-option")).toHaveCount(4);
    await page.getByRole("button", { name: "Start Talking" }).click();
    await expect(page.locator("body")).toHaveClass(/cf-voice-active/);
    await expect(page.getByRole("button", { name: "Stop voice conversation" })).toBeVisible();
    await page.getByRole("button", { name: "Stop voice conversation" }).click();
    await expect(page.locator("body")).not.toHaveClass(/cf-voice-active/);
    await expect(page.locator("#toast")).toContainText("Voice conversation stopped.");
  });

  test("transcribes a simulated voice turn and sends it through chat", async ({ page }) => {
    const { chatRequests, transcriptionRequests } = await installApiMocks(page);
    await installFakeVoiceRuntime(page);
    await page.goto("/");
    await expect(page.locator(".profile-button")).toContainText("Alpha Tester");
    await page.getByRole("button", { name: "Start voice conversation" }).click();
    await page.getByRole("button", { name: "Start Talking" }).click();
    await expect(page.locator("body")).toHaveClass(/cf-voice-active/);
    await page.evaluate(() => { window.__voiceTestAudioActive = true; });
    await page.waitForTimeout(650);
    await page.evaluate(() => { window.__voiceTestAudioActive = false; });
    await expect.poll(() => transcriptionRequests.length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => chatRequests.length, { timeout: 15_000 }).toBe(1);
    await expect(page.locator("#messages")).toContainText("Dhwani AI test reply received.", { timeout: 15_000 });
    await expect.poll(
      () => page.evaluate(() => window.__playedVoiceUtterances.join(" ")),
      { timeout: 10_000 },
    ).toContain("Dhwani AI test reply received");
    expect(await page.evaluate(() => window.__getUserMediaCalls)).toBe(1);
    expect(transcriptionRequests[0].contentType).toContain("multipart/form-data");
    expect(JSON.stringify(chatRequests[0])).toContain("Hello Dhwani, this is a voice test.");
  });
  test("allows guest Smart chat through the shared FreeLLMAPI first hop", async ({ page }) => {
    const { chatRequests } = await installApiMocks(page, { signedOut: true });
    await page.goto("/");
    await continueAsGuest(page);
    await page.locator("#promptInput").fill("Test private Smart access without signing in.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => chatRequests.length, { timeout: 20_000 }).toBe(1);
    await expect(page.locator("#messages")).toContainText("Dhwani AI test reply received.", { timeout: 20_000 });
    expect(chatRequests[0]?.provider).toBe("smart");
    expect(chatRequests[0]?.chatMode).toBe("smart");
  });

  test("requires explicit terms consent before starting Google OAuth", async ({ page }) => {
    await installApiMocks(page, { signedOut: true });
    const oauthRequests = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/auth/google") oauthRequests.push(request.url());
    });
    await page.goto("/");
    const google = page.getByRole("button", { name: "Continue with Google" });
    await expect(google).toBeDisabled();
    await page.locator("#cfAuthConsent").check();
    await expect(google).toBeEnabled();
    await google.click();
    await expect.poll(() => oauthRequests.length, { timeout: 10_000 }).toBe(1);
  });

});


test.describe("Dhwani AI responsive desktop and mobile layout", () => {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "laptop", width: 1280, height: 800 },
    { name: "small laptop", width: 1024, height: 768 },
  ]) {
    test(`keeps the ${viewport.name} workspace usable at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installApiMocks(page);
      await page.goto("/");
      await expect(page.locator("#sidebar")).toBeVisible();
      await expect(page.locator("#promptInput")).toBeVisible();
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start voice conversation" })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    });
  }

  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "narrow mobile", width: 360, height: 740 },
  ]) {
    test(`keeps the ${viewport.name} composer visible and navigation operable at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installApiMocks(page);
      await page.goto("/");
      await expect(page.locator("#promptInput")).toBeVisible();
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start voice conversation" })).toBeVisible();

      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

      await page.locator("#sidebarToggle").click();
      await expect(page.locator("#sidebar")).toHaveClass(/open/);
      await expect(page.locator("#sidebarOverlay")).toBeVisible();
      // The mobile drawer intentionally spans the viewport, so its close control is the operable dismissal path.
      await page.locator("#sidebar .sidebar-close").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
      await expect(page.locator("#sidebarOverlay")).toBeHidden();
    });
  }
});
