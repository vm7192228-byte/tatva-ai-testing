import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMediaApiRequest } from "@/lib/media-api.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function chatRequest(content: string) {
  return new Request("https://codeforge.example/api/chat", {
    method: "POST",
    headers: { origin: "https://codeforge.example", "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content }],
    }),
  });
}

describe("long-form video transition guard", () => {
  it("retires legacy short-video chat routing without contacting a provider or consuming credits", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleMediaApiRequest(
      chatRequest("Create a complete cinematic video about the solar system for social media."),
      {},
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    const payload = await response!.json();
    expect(payload.error).toBe("LONG_FORM_VIDEO_PIPELINE_NOT_READY");
    expect(payload.message).toContain("No provider request was sent");
    expect(payload.message).toContain("no video credits were consumed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves ordinary video how-to questions on the normal chat route", async () => {
    const response = await handleMediaApiRequest(
      chatRequest("How do I add captions to a YouTube video?"),
      {},
    );

    expect(response).toBeNull();
  });

  it.each([
    "Create a video script about the solar system.",
    "Generate a prompt for an image of a mountain landscape.",
    "Create a photo editing app that organizes images.",
    "Create a logo prompt for a neighborhood coffee shop.",
    "वीडियो की स्क्रिप्ट लिखो।",
    "फोटो का प्रॉम्प्ट बनाओ।",
    "फोटो एडिटिंग ऐप बनाओ।",
    "लोगो का प्रॉम्प्ट लिखो।",
  ])("keeps text and software deliverables on the normal chat route: %s", async (prompt) => {
    const response = await handleMediaApiRequest(chatRequest(prompt), {});

    expect(response).toBeNull();
  });

  it.each([
    "video ki script bana do",
    "photo editing app banao",
    "write a script for a video about the solar system",
    "Give me two video templates about space.",
    "Give me two templates for a video about space.",
    "video ke liye do template de do",
    "मेरे वीडियो के लिए दो टेम्पलेट दे दो.",
  ])("keeps Romanized Hinglish text deliverables on the normal chat route: %s", async (prompt) => {
    const response = await handleMediaApiRequest(chatRequest(prompt), {});

    expect(response).toBeNull();
  });

  it("keeps explicit image-generation requests on the authenticated media route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleMediaApiRequest(
      chatRequest("Generate an image of a mountain at sunrise."),
      {},
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const payload = await response!.json();
    expect(payload.error).toBe("AUTH_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not misclassify a real poster request as a text-only task", async () => {
    const response = await handleMediaApiRequest(
      chatRequest("Create a poster for our school science exhibition."),
      {},
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const payload = await response!.json();
    expect(payload.error).toBe("AUTH_REQUIRED");
  });

  it("does not advertise video generation as available while the long-form pipeline is disabled", async () => {
    const response = await handleMediaApiRequest(
      new Request("https://codeforge.example/api/media", { method: "GET" }),
      {
        CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
        FREELLMAPI_API_KEY: "test-only-key",
      },
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = await response!.json();
    expect(payload.providers.image).toBe(true);
    expect(payload.providers.video).toBe(false);
    expect(payload.note).toContain("Video generation remains disabled until its asynchronous job pipeline is ready.");
  });
  it("reports Cloudflare as a secondary image provider without replacing FreeLLMAPI as primary", async () => {
    const response = await handleMediaApiRequest(
      new Request("https://codeforge.example/api/media", { method: "GET" }),
      {
        CODEFORGE_GATEWAY_URL: "https://primary-gateway.example",
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "server-only-test-token",
      },
    );

    expect(response).not.toBeNull();
    const payload = await response!.json();
    expect(payload.provider).toBe("CodeForge private gateway");
    expect(payload.fallbackProvider).toBe("Cloudflare Workers AI");
    expect(payload.providers).toMatchObject({
      image: true,
      imagePrimary: true,
      imagePrivateFallback: false,
      imageFallback: true,
      video: false,
    });
  });
});
