import { finalizeUsageQuota, reserveUsageQuota, type UsageReservationAction, type UsageReservationDecision } from "./usage-limits.server";
import { getAuthenticatedSession } from "./auth-api.server";

type RuntimeEnv = Record<string, unknown>;

type MediaType = "image" | "video";

/** Recognize media requests in English, Devanagari Hindi, and Romanized Hindi. */
function detectMediaIntent(prompt: string): MediaType | null {
  const text = prompt.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^(?:how\b|how can\b|how do\b|what is\b|what are\b|tell me how\b|steps to\b|tutorial\b|guide me\b|kaise\b|कैसे\b|किस तरह\b|किस तरीके से\b|मुझे बताओ\b|बताओ\b|समझाओ\b)/i.test(text)) return null;
  if (/^(?:write|suggest|give|help me write)\b.{0,55}\bprompt\b/i.test(text) && !/\b(?:create|make|generate|draw)\b.{0,25}\b(?:image|photo|picture|video)\b/i.test(text)) return null;

  const imageTargets = /\b(?:images?|pictures?|photos?|photographs?|pics?|drawings?|illustrations?|artworks?|portraits?|paintings?|wallpapers?|thumbnails?|posters?|logos?|icons?|cover art|visuals?|scenes?|infographics?|screenshots?|renders?|art)\b|(?:तस्वीर|फोटो|इमेज|चित्र|तसवीर|पोस्टर|थंबनेल|लोगो|चित्रण|वॉलपेपर|पेंटिंग|दृश्य|इन्फोग्राफिक|स्क्रीनशॉट|ड्रॉइंग)/gi;
  const videoTargets = /\b(?:videos?|clips?|reels?|shorts?|animations?|motion videos?)\b|(?:वीडियो|रील|क्लिप|एनिमेशन|चलता हुआ वीडियो)/gi;
  const generationVerbs = /\b(?:generate|create|make|draw|paint|render|design|produce|animate|turn|convert|want|need|give(?:\s+me)?|show(?:\s+me)?|send(?:\s+me)?|make\s+me|create\s+for\s+me|i\s+want|i\s+need|depict|illustrate|visualize|bana(?:\s+(?:do|de|dena|dijiye|kar|ke|karke))?|banao|banaiye|banaaiye|chahiye|dikhao|bhejo|de\s*do|photo\s+bana|tasveer\s+bana)\b|(?:बना(?:\s*(?:दो|दे|दीजिए|दें|करो|करके|कर|के|ना|ओ|इए|एं|दूँ|दूं))?|बनाओ|बनाइए|बनाकर|तैयार करो|जनरेट करो|बनवा(?:ओ|एं|इए|दो)?|चाहिए|दिखा(?:ओ|एं|इए)?|दिखा\s*दो|भेज\s*दो|दे\s*दो|दे\s*देना|दे\s*दीजिए)/gi;
  const hasGenerationAction = /\b(?:generate|create|make|draw|paint|render|design|produce|animate|turn|convert|want|need|give(?:\s+me)?|show(?:\s+me)?|send(?:\s+me)?|make\s+me|create\s+for\s+me|i\s+want|i\s+need|depict|illustrate|visualize|bana(?:\s+(?:do|de|dena|dijiye|kar|ke|karke))?|banao|banaiye|banaaiye|chahiye|dikhao|bhejo|de\s*do|photo\s+bana|tasveer\s+bana)\b|(?:बना(?:\s*(?:दो|दे|दीजिए|दें|करो|करके|कर|के|ना|ओ|इए|एं|दूँ|दूं))?|बनाओ|बनाइए|बनाकर|तैयार करो|जनरेट करो|बनवा(?:ओ|एं|इए|दो)?|चाहिए|दिखा(?:ओ|एं|इए)?|दिखा\s*दो|भेज\s*दो|दे\s*दो|दे\s*देना|दे\s*दीजिए)/i.test(text);

  const videoTextDeliverable = /\b(?:video|reel|shorts?|clip)\s+(?:(?:ke|ki|ka)\s+liye\s+)?(?:(?:two|2|one|1|a|some|do|ek)\s+)?(?:prompts?|templates?|scripts?|storyboards?|captions?|shot lists?|voiceovers?|narrations?)\b|\b(?:prompts?|templates?|storyboards?|captions?|shot lists?|voiceovers?|narrations?)\b.{0,55}\b(?:for|of|ke liye|ki liye|ka liye)\b.{0,25}\b(?:(?:my|a|the|mera|mere|meri)\s+|एक\s+)?(?:video|reel|shorts?|clip)\b|(?:वीडियो|रील|शॉर्ट्स?|क्लिप)\s*(?:के लिए|की खातिर|का)?\s*(?:(?:दो|एक|2|1)\s*)?(?:प्रॉम्प्ट|टेम्पलेट(?:्स)?|स्क्रिप्ट|स्टोरीबोर्ड|कैप्शन|शॉट लिस्ट|वॉइसओवर)/i.test(text);
  if (videoTextDeliverable) return null;

  const nonVisualOutput = /\b(?:website|web app|application|app|code|script|program|function|sql|query|database|table|spreadsheet|excel formula|email|message|paragraph|story|essay|poem|summary|plan|list|resume|cv|letter|report|invoice|certificate|pdf|document|pptx|presentation|slide deck|quiz|worksheet|book|ebook|notes|recipe|business plan|contract|policy|schema|api|bot|calculator|lesson|course|assignment|data analysis|prompts?|scripts?|captions?|descriptions?|outlines?|storyboards?|transcripts?|tutorials?|guides?)\b|(?:वेबसाइट|ऐप|कोड|स्क्रिप्ट|प्रोग्राम|क्वेरी|डेटाबेस|तालिका|ईमेल|संदेश|कहानी|कविता|रिपोर्ट|रिज्यूमे|पत्र|प्रमाणपत्र|पीडीएफ|दस्तावेज़|प्रेजेंटेशन|नोट्स|पाठ्यक्रम|असाइनमेंट)/i;

  // Ordinary conversation and hypothetical questions must never trigger image generation.
  if (/\b(?:if i|if you|what if|what would|would you|imagine if|talk to me|chat with me|repeat(?: this)? text|repeat that|rephrase|rewrite|say that again|read this|summarize this|explain this text)\b|(?:अगर|यदि|मान लो|क्या होता अगर|तुम क्या करोगे|तुम क्या करोगी|क्या करोगे|क्या करोगी|बात करो|बात कर रहा|बात कर रही|मैंने कहा था|इस टेक्स्ट को|यह टेक्स्ट|इसे दोबारा|दोबारा बताओ|फिर से बताओ|इसे दोहराओ|दोबारा लिखो|फिर से लिखो|पब्लिक कर दूँ|पब्लिक कर दूं|सार्वजनिक कर)/i.test(text)) return null;

  const objects: Array<{ type: MediaType; index: number; length: number }> = [];
  for (const match of text.matchAll(imageTargets)) objects.push({ type: "image", index: match.index ?? 0, length: match[0].length });
  for (const match of text.matchAll(videoTargets)) objects.push({ type: "video", index: match.index ?? 0, length: match[0].length });
  objects.sort((a, b) => a.index - b.index);

  // A media noun can describe text or software rather than the requested
  // deliverable (for example, "write a video script" or "build a photo app").
  // Keep those requests on chat; only route when the visual asset is the output.
  const firstTextDeliverable = nonVisualOutput.exec(text);
  const mediaToolDeliverable =
    /\b(?:images?|pictures?|photos?|videos?|clips?|reels?|shorts?)\s+(?:(?:edit|editing|editor|generator|generation|generating|analysis|analytics|management|sharing|processing|conversion)\s+)*(?:apps?|tools?|websites?|software|platforms?|services?|apis?)\b/i.test(text) ||
    /\b(?:photo|image|video|tasveer|tasvir)\s+(?:(?:edit|editing|generate|generation|analysis|analytics|manage|management|process|processing)\s+)*(?:apps?|tools?|websites?|software|platforms?|services?|apis?)\b/i.test(text) ||
    /(?:तस्वीर|फोटो|इमेज|चित्र|वीडियो|रील|क्लिप|शॉर्ट्स?)\s*(?:(?:एडिटिंग|संपादन|जनरेशन|विश्लेषण|एनालिटिक्स|मैनेजमेंट|शेयरिंग|प्रोसेसिंग|कन्वर्ज़न)\s*)*(?:ऐप|एप्लिकेशन|टूल|वेबसाइट|सॉफ्टवेयर|प्लेटफॉर्म|सेवा|एपीआई)/i.test(text);
  const mediaAsText =
    /\b(?:images?|pictures?|photos?|videos?|clips?|reels?|shorts?|posters?|logos?|icons?|thumbnails?|wallpapers?)\s+(?:(?:of|for|ke|ki|ka)\s+)*(?:prompts?|scripts?|captions?|descriptions?|outlines?|storyboards?|transcripts?)\b/i.test(text) ||
    /\b(?:prompt|script|caption|description|outline|storyboard|transcript)\s+(?:(?:for|of|ke|ki|ka)\s+)*(?:images?|pictures?|photos?|videos?|clips?|reels?|shorts?|posters?|logos?|icons?|thumbnails?)\b/i.test(text) ||
    /(?:तस्वीर|फोटो|इमेज|चित्र|पोस्टर|लोगो|थंबनेल|वॉलपेपर|वीडियो|रील|क्लिप|शॉर्ट्स?)\s*(?:के|की|का)?\s*(?:प्रॉम्प्ट|स्क्रिप्ट|कैप्शन|विवरण|रूपरेखा|स्टोरीबोर्ड|ट्रांसक्रिप्ट)/i.test(text) ||
    /\b(?:video|image|photo|picture|reel|clip|shorts?)\s+(?:(?:ki|ka|ke)\s+)?(?:prompt|script|caption|description|outline|storyboard|transcript)\b/i.test(text);
  if (
    mediaToolDeliverable ||
    mediaAsText ||
    (firstTextDeliverable && objects[0] && firstTextDeliverable.index < objects[0].index)
  ) {
    return null;
  }

  if (/\b(?:thumbnail|wallpaper|poster|logo|icon|cover art|profile picture)\b|(?:थंबनेल|पोस्टर|लोगो|वॉलपेपर)/i.test(text) && hasGenerationAction) return "image";

  if (objects.length) {
    const howTo = /\b(?:how to|how do i|how can i|what is the best way to|steps to|tutorial)\b/i.exec(text);
    if (howTo && objects[0]!.index > howTo.index) return null;
    for (const verb of text.matchAll(generationVerbs)) {
      const index = verb.index ?? 0;
      const verbEnd = index + verb[0].length;
      const following = objects.find(object => object.index >= index && object.index - verbEnd <= 160);
      if (following) return following.type;
      const previous = objects.filter(object => object.index < index && index - (object.index + object.length) <= 160).at(-1);
      if (previous) return previous.type;
    }
    const trailingAction = /(?:chahiye|please|de\s*do|dikha\s*do|bhej\s*do|bana\s*do|bana\s*ke\s*do|करते\s*हुए|बना\s*दो|दे\s*दो|दिखा\s*दो|भेज\s*दो|चाहिए)/i.test(text);
    if (trailingAction) return objects.find(object => object.type === "video")?.type ?? "image";
    return null;
  }

  // No explicit image/video deliverable was named; keep this as normal chat.
  return null;
}

/** Enrich prompts generically so the generator follows the requested subject and scene. */
function enhanceMediaPrompt(prompt: string, type: MediaType): string {
  const text = prompt.toLowerCase().normalize("NFKC");
  const outputType = type === "video" ? "video" : "image";
  const core = "Generate the actual " + outputType + " described below. Do not return advice, an image prompt, a description, or instructions for using another website. Treat the user's message as the visual brief. Preserve the exact main subject, identity, number of people or objects, action, pose, setting, clothing, objects, era, and requested style. Use details supplied by the user; do not replace a named person, deity, historical figure, animal, place, or object with an unrelated subject. Do not add unrelated religious figures or statues. Keep the composition coherent, respectful where appropriate, and visually clear.\nOriginal user request: " + prompt;

  const durgaSubject = /(?:माँ\s*)?(?:दुर्गा|दुर्गा\s*माँ|दुर्गा\s*देवी|maa\s*durga|mata\s*durga|goddess\s+durga|durga)/iu.test(text);
  const mahishasuraScene = /(?:महिषासुर|mahishasur|mahishasura).{0,100}(?:वध|मार|vadh|wadh|maar|defeat|slay|kill|hara(?:na|te|kar)?)|(?:वध|defeat|slay|kill|vadh|wadh|maar|hara(?:na|te|kar)?).{0,100}(?:महिषासुर|mahishasur|mahishasura)/iu.test(text);
  if (durgaSubject && mahishasuraScene) {
    return core + "\nScene accuracy: depict Goddess Durga as the central subject defeating Mahishasura, as requested. Use recognizable Durga imagery such as multiple arms holding divine weapons, a trident, and her lion mount when consistent with the brief. Keep Mahishasura clearly distinct from Durga. Do not substitute Lord Shiva, Krishna, Gautama Buddha, or any unrelated figure.";
  }

  const shivaSubject = /(?:भगवान\s*)?(?:शिव\s*जी?|महादेव|भोलेनाथ|शंकर\s*जी?|शिवशंकर|lord\s+shiva|shiva|shiv\s*ji|shivji|mahadev|bholenath|mahesh|neelkanth|नीलकंठ)/iu.test(text);
  if (shivaSubject) {
    return core + "\nIdentity cues for Lord Shiva: matted jata hair, crescent moon, third eye, blue Neelkanth throat, rudraksha beads, trishul and damaru; a serpent and Himalayan/Kailash atmosphere may be used when appropriate. Keep Shiva distinct from Gautama Buddha.";
  }

  const krishnaSubject = /(?:श्री\s*)?(?:कृष्ण|कान्हा|कन्हैया|गोपाल|मुरलीधर|गोविंद|गोविन्द|घनश्याम|lord\s+krishna|shri\s+krishna|krishna\s*ji|krishna|kanha|kann?haiya|gopal|murlidhar|govind|ghanshyam)/iu.test(text);
  if (krishnaSubject) {
    return core + "\nIdentity cues for Lord Shri Krishna: a peacock feather, traditional yellow pitambar, flute, Vaishnava tilak, floral garland, and a serene youthful divine appearance when appropriate to the user's requested style. Preserve the requested scene and do not substitute another religious figure.";
  }

  return core;
}

const mediaRateLimits = new Map<string, { count: number; resetsAt: number }>();
const WINDOW_MS = 60_000;

function envValue(name: string, runtimeEnv: unknown): string | undefined {
  const binding = runtimeEnv && typeof runtimeEnv === "object"
    ? (runtimeEnv as RuntimeEnv)[name]
    : undefined;
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  const processLike = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function allowMediaRequest(identity: string, type: MediaType) {
  const now = Date.now();
  for (const [key, value] of mediaRateLimits) {
    if (value.resetsAt <= now) mediaRateLimits.delete(key);
  }
  const key = type + ":" + identity.slice(0, 140);
  const limit = type === "video" ? 1 : 3;
  const current = mediaRateLimits.get(key);
  if (!current || current.resetsAt <= now) {
    mediaRateLimits.set(key, { count: 1, resetsAt: now + WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function binaryFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function cloudflareImage(prompt: string, runtimeEnv: unknown): Promise<Response> {
  const accountId = envValue("CLOUDFLARE_ACCOUNT_ID", runtimeEnv);
  const token = envValue("CLOUDFLARE_API_TOKEN", runtimeEnv) ?? envValue("CLOUDFLARE_API_KEY", runtimeEnv);
  if (!accountId || !token) {
    return json({
      error: "IMAGE_PROVIDER_NOT_CONFIGURED",
      message: "Image generation needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN configured as server-side secrets.",
    }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(accountId) +
      "/ai/run/@cf/black-forest-labs/flux-1-schnell",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          accept: "application/json, image/jpeg",
        },
        body: JSON.stringify({ prompt, steps: 4 }),
        signal: AbortSignal.timeout(55_000),
      },
    );
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return json({
      error: timedOut ? "IMAGE_PROVIDER_TIMEOUT" : "IMAGE_PROVIDER_UNREACHABLE",
      message: timedOut
        ? "Cloudflare image generation took too long. Try a shorter prompt and retry."
        : "Could not reach Cloudflare Workers AI from the server.",
    }, 502);
  }

  if (!upstream.ok) {
    const status = upstream.status;
    const detail = status === 401 || status === 403
      ? "Cloudflare rejected the token or it lacks Workers AI run permissions. Check the token in Vercel."
      : status === 429
        ? "Cloudflare Workers AI quota or rate limit was reached. Check the account's AI usage."
        : "Cloudflare Workers AI returned HTTP " + status + ". Check the model availability and account settings.";
    try { await upstream.body?.cancel(); } catch { /* No upstream body is needed. */ }
    return json({ error: "IMAGE_PROVIDER_ERROR", message: detail }, status === 429 ? 429 : 502);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    const imageBytes = await readBoundedResponseBytes(upstream, MAX_IMAGE_BYTES);
    if (!imageBytes || imageBytes.byteLength === 0) {
      return json({ error: "IMAGE_PROVIDER_BAD_RESPONSE", message: "Cloudflare returned an empty, interrupted, or oversized image response." }, 502);
    }
    return new Response(toArrayBuffer(imageBytes), {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-codeforge-media-provider": "Cloudflare Workers AI",
      },
    });
  }

  const jsonBytes = await readBoundedResponseBytes(upstream, MAX_IMAGE_JSON_BYTES);
  if (!jsonBytes || jsonBytes.byteLength === 0) {
    return json({ error: "IMAGE_PROVIDER_BAD_RESPONSE", message: "Cloudflare returned an empty, interrupted, or oversized image response." }, 502);
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown; }
  catch { return json({ error: "IMAGE_PROVIDER_BAD_RESPONSE", message: "Cloudflare returned an unreadable image response." }, 502); }

  if (!payload || typeof payload !== "object") {
    return json({ error: "IMAGE_PROVIDER_BAD_RESPONSE", message: "Cloudflare returned an empty image response." }, 502);
  }
  const response = payload as { success?: unknown; errors?: unknown; result?: { image?: unknown } | string };
  const image = typeof response.result === "object" && response.result !== null ? response.result.image : undefined;
  if (response.success === false || typeof image !== "string" || !image.trim()) {
    return json({
      error: "IMAGE_PROVIDER_FAILED",
      message: "Cloudflare did not return an image. Check Workers AI access, quota and FLUX model availability.",
    }, 502);
  }
  try {
    const imageBytes = binaryFromBase64(image);
    if (imageBytes.byteLength === 0 || imageBytes.byteLength > MAX_IMAGE_BYTES) {
      return json({ error: "IMAGE_PROVIDER_BAD_RESPONSE", message: "Cloudflare returned an empty or oversized image response." }, 502);
    }
    return new Response(toArrayBuffer(imageBytes), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-codeforge-media-provider": "Cloudflare Workers AI",
      },
    });
  } catch {
    return json({ error: "IMAGE_PROVIDER_BAD_RESPONSE", message: "Cloudflare returned image data that could not be decoded." }, 502);
  }
}

function normalizeCodeForgeMediaBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    let path = url.pathname;
    while (path.endsWith("/")) path = path.slice(0, -1);
    return url.origin + (path.toLowerCase().endsWith("/v1") ? path : path + "/v1");
  } catch {
    return undefined;
  }
}

type CodeForgeMediaSettings = {
  primaryBaseUrl: string | undefined;
  fallbackBaseUrl: string | undefined;
  fallback2BaseUrl: string | undefined;
  fallback3BaseUrl: string | undefined;
};

function codeForgeMediaSettings(runtimeEnv: unknown): CodeForgeMediaSettings | null {
  const primaryBaseUrl = normalizeCodeForgeMediaBaseUrl(envValue("CODEFORGE_GATEWAY_URL", runtimeEnv));
  const fallbackBaseUrl = normalizeCodeForgeMediaBaseUrl(envValue("CODEFORGE_GATEWAY_FALLBACK_URL", runtimeEnv));
  const fallback2BaseUrl = normalizeCodeForgeMediaBaseUrl(envValue("CODEFORGE_GATEWAY_FALLBACK_2_URL", runtimeEnv));
  const fallback3BaseUrl = normalizeCodeForgeMediaBaseUrl(envValue("CODEFORGE_GATEWAY_FALLBACK_3_URL", runtimeEnv));
  if (!primaryBaseUrl && !fallbackBaseUrl && !fallback2BaseUrl && !fallback3BaseUrl) return null;
  return { primaryBaseUrl, fallbackBaseUrl, fallback2BaseUrl, fallback3BaseUrl };
}

function gatewayImageErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "The private AI gateway did not accept this signed-in session. Check that Preview and the gateway trust the same Supabase Auth issuer.";
  if (status === 404 || status === 422) return "The private AI gateway has no enabled image model for this request. Enable an approved image model in the CodeForge gateway catalog.";
  if (status === 429) return "The private AI gateway or its upstream image provider is rate limited. Please wait before trying again.";
  if (status === 402) return "The private AI gateway's image budget is exhausted. No image was returned.";
  return "The private AI gateway could not complete image generation. Check its model catalog and provider status.";
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_JSON_BYTES = 4 * 1024 * 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* Stop reading an oversized provider response. */ }
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    try { await reader.cancel(); } catch { /* The provider stream is already interrupted. */ }
    return null;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function privateGatewayImageFailure(status: number, upstreamCode = ""): Response {
  // Budget refusals are terminal. Retrying another gateway or the direct
  // Cloudflare fallback here would route around the provider's spend cap.
  const budgetBlocked = /^PROVIDER_IMAGE_BUDGET_/.test(upstreamCode);
  const retryable = !budgetBlocked && (
    status === 408 || status === 409 || status === 425 ||
    status === 429 || status >= 500
  );
  return json(
    {
      error: budgetBlocked ? "PROVIDER_IMAGE_BUDGET_BLOCKED" : "CODEFORGE_GATEWAY_IMAGE_ERROR",
      ...(budgetBlocked ? { code: upstreamCode } : {}),
      message: budgetBlocked
        ? "Image generation is paused because this provider's monthly image budget is missing, invalid, or exhausted. No fallback provider was contacted."
        : gatewayImageErrorMessage(status),
    },
    status === 429 ? 429 : 502,
    {
      "x-codeforge-upstream-status": String(status),
      "x-codeforge-failover-allowed": retryable ? "true" : "false",
    },
  );
}

async function generateCodeForgeImage(
  prompt: string,
  runtimeEnv: unknown,
  accessToken: string,
  baseUrl: string,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(baseUrl + "/images/generations", {
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
        accept: "application/json, image/*",
      },
      body: JSON.stringify({
        model: configuredGatewayImageModel(runtimeEnv)!,
        prompt,
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(50_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return json({
      error: timeout ? "IMAGE_PROVIDER_TIMEOUT" : "IMAGE_PROVIDER_UNREACHABLE",
      message: timeout
        ? "The private image gateway timed out. Check whether its Render service is waking or whether an image model is enabled."
        : "Could not reach the configured private image gateway.",
    }, timeout ? 504 : 502);
  }

  if (!upstream.ok) {
    const status = upstream.status;
    let upstreamCode = "";
    try {
      const payload = await upstream.clone().json() as {
        error?: { code?: unknown } | string;
        code?: unknown;
      };
      const error = payload.error;
      if (error && typeof error === "object" && typeof error.code === "string") {
        upstreamCode = error.code;
      } else if (typeof payload.code === "string") {
        upstreamCode = payload.code;
      }
    } catch {
      // Non-JSON errors retain the normal status-based retry behavior.
    }
    try { await upstream.body?.cancel(); } catch { /* Return only the normalized status. */ }
    return privateGatewayImageFailure(status, upstreamCode);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("image/")) {
    const imageBytes = await readBoundedResponseBytes(upstream, MAX_IMAGE_BYTES);
    if (!imageBytes || imageBytes.byteLength === 0) {
      return json({
        error: "CODEFORGE_GATEWAY_IMAGE_BAD_RESPONSE",
        message: "The private image gateway returned an empty, interrupted or oversized image response.",
      }, 502);
    }
    return new Response(toArrayBuffer(imageBytes), {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-codeforge-media-provider": "CodeForge private gateway",
      },
    });
  }

  const jsonBytes = await readBoundedResponseBytes(upstream, MAX_IMAGE_JSON_BYTES);
  if (!jsonBytes || jsonBytes.byteLength === 0) {
    return json({ error: "CODEFORGE_GATEWAY_IMAGE_BAD_RESPONSE", message: "The private image gateway returned an empty or oversized response." }, 502);
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown; }
  catch { return json({ error: "CODEFORGE_GATEWAY_IMAGE_BAD_RESPONSE", message: "The private image gateway returned unreadable JSON." }, 502); }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const items = record?.["data"];
  const first = Array.isArray(items) ? items[0] : null;
  const firstRecord = first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : null;
  const base64Image = typeof firstRecord?.["b64_json"] === "string" ? firstRecord["b64_json"].trim() : "";
  if (base64Image.length > 100) {
    try {
      const imageBytes = binaryFromBase64(base64Image);
      if (imageBytes.byteLength > 0 && imageBytes.byteLength <= MAX_IMAGE_BYTES) {
        return new Response(toArrayBuffer(imageBytes), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-codeforge-media-provider": "CodeForge private gateway",
          },
        });
      }
    } catch { /* Return the normalized provider error below. */ }
  }
  return json({
    error: "CODEFORGE_GATEWAY_IMAGE_BAD_RESPONSE",
    message: "The private image gateway did not return a valid base64 image response.",
  }, 502);
}

function configuredGatewayImageModel(runtimeEnv: unknown): string | null {
  const model = envValue("CODEFORGE_GATEWAY_IMAGE_MODEL", runtimeEnv)?.trim();
  // Never allow the gateway's automatic catalog selection for paid media:
  // the upstream model and its per-image price must be reviewed explicitly.
  if (!model || model.toLowerCase() === "auto") return null;
  return model;
}

function cloudflareImageConfigured(runtimeEnv: unknown): boolean {
  return Boolean(
    envValue("CLOUDFLARE_ACCOUNT_ID", runtimeEnv) &&
    (envValue("CLOUDFLARE_API_TOKEN", runtimeEnv) ?? envValue("CLOUDFLARE_API_KEY", runtimeEnv))
  );
}

/** Try only independent private gateway instances; Cloudflare is an optional last-resort image fallback. */
async function generateImageWithFallback(
  prompt: string,
  runtimeEnv: unknown,
  accessToken: string,
): Promise<Response> {
  if (!accessToken) {
    return json({ error: "AUTH_REQUIRED", message: "Sign in to generate images through the private AI gateway." }, 401);
  }
  const config = codeForgeMediaSettings(runtimeEnv);
  if (!config) {
    return json({
      error: "PROVIDER_NOT_CONFIGURED",
      message: "Image generation needs a configured private CodeForge gateway with an enabled image model.",
    }, 503);
  }

  const candidates = [...new Set([
    config.primaryBaseUrl,
    config.fallbackBaseUrl,
    config.fallback2BaseUrl,
    config.fallback3BaseUrl,
  ].filter((value): value is string => Boolean(value)))];
  const cloudflareAvailable = cloudflareImageConfigured(runtimeEnv);
  let last: Response | null = null;
  let shouldTryCloudflare = false;

  for (let index = 0; index < candidates.length; index += 1) {
    const baseUrl = candidates[index]!;
    let response: Response;
    try {
      response = await generateCodeForgeImage(prompt, runtimeEnv, accessToken, baseUrl);
    } catch {
      response = json({ error: "CODEFORGE_GATEWAY_IMAGE_UNAVAILABLE", message: "The private image gateway failed before returning a response." }, 502);
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (response.ok && type.startsWith("image/")) return response;

    const upstreamStatus = Number(response.headers.get("x-codeforge-upstream-status") || response.status);
    const failoverAllowed = response.headers.get("x-codeforge-failover-allowed") === "true" ||
      [502, 503, 504].includes(response.status) && response.headers.get("x-codeforge-upstream-status") === null;
    last = response;
    shouldTryCloudflare = failoverAllowed;

    // Keep the last response body readable when there is nowhere else to route it.
    // This matters for returning a normalized error to the API caller.
    const anotherPrivateGateway = index < candidates.length - 1;
    const canTryCloudflare = cloudflareAvailable && shouldTryCloudflare;
    if (!failoverAllowed || (!anotherPrivateGateway && !canTryCloudflare)) return response;
    if (upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 402) return response;

    try { await response.body?.cancel(); } catch { /* The next independent route is tried only for retryable failures. */ }
  }

  if (cloudflareAvailable && shouldTryCloudflare) {
    try {
      const fallback = await cloudflareImage(prompt, runtimeEnv);
      const fallbackType = (fallback.headers.get("content-type") ?? "").toLowerCase();
      if (fallback.ok && fallbackType.startsWith("image/")) return fallback;
      try { await fallback.body?.cancel(); } catch { /* Normalize the fallback failure below. */ }
      return json({
        error: "IMAGE_PROVIDERS_UNAVAILABLE",
        message: "The private gateways and configured Cloudflare image fallback are unavailable. Your reserved image allowance will be released.",
      }, fallback.status === 429 ? 429 : 502);
    } catch {
      return json({
        error: "IMAGE_PROVIDERS_UNAVAILABLE",
        message: "The private gateways and configured Cloudflare image fallback are unavailable. Your reserved image allowance will be released.",
      }, 502);
    }
  }

  return last ?? json({ error: "PROVIDER_NOT_CONFIGURED", message: "No private image gateway is configured." }, 503);
}

async function finalizeImageQuotaReservation(
  runtimeEnv: unknown,
  userId: string,
  reservationId: string,
  action: UsageReservationAction,
): Promise<boolean> {
  try {
    const result = await finalizeUsageQuota(runtimeEnv, userId, reservationId, action);
    if (!result.ok || result.status !== (action === "commit" ? "committed" : "released")) {
      console.error("[Dhwani AI] Image quota reservation could not be finalized.");
      return false;
    }
    return true;
  } catch {
    console.error("[Dhwani AI] Image quota reservation finalization failed.");
    return false;
  }
}

/** Same-origin media generation API; provider credentials are server-side only. */
export async function handleMediaApiRequest(request: Request, runtimeEnv: unknown): Promise<Response | null> {
  const url = new URL(request.url);
  const isChatAutoRoute = url.pathname === "/api/chat";
  const isMediaRoute = url.pathname === "/api/media";
  if (!isChatAutoRoute && !isMediaRoute) return null;
  // The shared chat composer routes clear media-generation requests here. For all other prompts,
  // return null without consuming the original request so the normal text-chat handler can answer.
  if (isChatAutoRoute && request.method !== "POST") return null;

  let routedType: MediaType | null = null;
  let routedPrompt = "";
  if (isChatAutoRoute) {
    let chatPayload: unknown;
    try { chatPayload = await request.clone().json(); }
    catch { return null; }
    if (!chatPayload || typeof chatPayload !== "object") return null;
    const rawMessages = (chatPayload as { messages?: unknown }).messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null;
    const lastUser = [...rawMessages].reverse().find(message =>
      message && typeof message === "object" && (message as { role?: unknown }).role === "user"
    ) as { content?: unknown; attachments?: unknown } | undefined;
    if (!lastUser || typeof lastUser.content !== "string" || (Array.isArray(lastUser.attachments) && lastUser.attachments.length > 0)) return null;
    // Never send channel analytics/research to paid image/video generation,
    // even if words like "YouTube", "video", or "analyse" confuse the media classifier.
    const channelAnalysis = /(?:my|our|mera|mere)\s+(?:youtube\s+)?channel|(?:youtube|yt)\s+(?:channel\s+)?(?:analyse|analyze|analysis|analytics|stats|performance)|(?:analyse|analyze).{0,35}channel|channel.{0,35}(?:analyse|analyze|analysis|analytics|stats|performance)|चैनल.{0,35}(?:विश्लेषण|एनालिसिस|आंकड़े|कैसा|देखो|बताओ)|(?:मेरा|मेरे)\s+(?:यूट्यूब\s+)?चैनल/i.test(lastUser.content);
    if (channelAnalysis) return null;
    routedType = detectMediaIntent(lastUser.content);
    if (!routedType) return null;
    if (routedType === "video") {
      return json({
        error: "LONG_FORM_VIDEO_PIPELINE_NOT_READY",
        message: "The legacy 5–8 second clip generator has been retired. Full-length creator video generation is not enabled yet. No provider request was sent and no video credits were consumed.",
      }, 503);
    }
    routedPrompt = lastUser.content.trim();
    if (!routedPrompt || routedPrompt.length > 1800) {
      return json({ error: "INVALID_PROMPT", message: "Please keep image/video prompts between 1 and 1,800 characters." }, 400);
    }
  }

  const privateMedia = codeForgeMediaSettings(runtimeEnv);
  const privateGatewayConfigured = Boolean(privateMedia);
  const cloudflareConfigured = cloudflareImageConfigured(runtimeEnv);
  if (isMediaRoute && request.method === "GET") {
    return json({
      ok: true,
      service: "Dhwani AI media API",
      providers: {
        image: privateGatewayConfigured,
        imagePrimary: Boolean(privateMedia?.primaryBaseUrl),
        imagePrivateFallback: Boolean(privateMedia?.fallbackBaseUrl),
        imagePrivateFallback2: Boolean(privateMedia?.fallback2BaseUrl),
        imagePrivateFallback3: Boolean(privateMedia?.fallback3BaseUrl),
        imageFallback: cloudflareConfigured,
        video: false,
        videoPrimary: false,
        videoFallback: false,
        videoFallbackConfigured: false,
      },
      provider: "CodeForge private gateway",
      fallbackProvider: "Cloudflare Workers AI",
      note: "Images use the private CodeForge gateway, with up to three optional independent private instances and Cloudflare image fallback. Video generation remains disabled until its asynchronous job pipeline is ready.",
    });
  }
  if (request.method !== "POST") {
    return isChatAutoRoute ? null : json({ error: "METHOD_NOT_ALLOWED", message: "Use GET for status or POST to generate media." }, 405, { allow: "GET, POST" });
  }
  if (!sameOrigin(request)) return json({ error: "ORIGIN_NOT_ALLOWED", message: "This request origin is not allowed." }, 403);
  const hasAuthCookie = /(?:^|;\s*)cf_(?:access|refresh)=/.test(request.headers.get("cookie") ?? "");
  if (!hasAuthCookie) return json({ error: "AUTH_REQUIRED", message: "Sign in to your Dhwani account before generating media." }, 401);
  const session = await getAuthenticatedSession(request, runtimeEnv, 2500);
  if (!session.configured) return json({ error: "AUTH_NOT_CONFIGURED", message: "Media generation requires the Dhwani Supabase sign-in service to be configured." }, 503);
  if (session.unavailable) return json({
      error: "AUTH_UNAVAILABLE",
      message: "The account service is temporarily unavailable. Your existing session has been preserved; please retry.",
    }, 503);
  if (!session.user) return json({ error: "AUTH_REQUIRED", message: "Your session has expired. Sign in again before generating media." }, 401);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return json({ error: "JSON_REQUIRED", message: "Send a JSON request body." }, 415);
  }

  let type: MediaType | null = routedType;
  let prompt = routedPrompt;
  if (isMediaRoute) {
    let raw: string;
    try { raw = await request.text(); }
    catch { return json({ error: "INVALID_BODY", message: "The request body could not be read." }, 400); }
    if (new TextEncoder().encode(raw).byteLength > 8_000) {
      return json({ error: "BODY_TOO_LARGE", message: "The media request is too large. Shorten the prompt." }, 413);
    }
    let payload: { type?: unknown; prompt?: unknown; duration?: unknown };
    try { payload = JSON.parse(raw) as typeof payload; }
    catch { return json({ error: "INVALID_JSON", message: "The request body is not valid JSON." }, 400); }
    type = payload.type === "image" || payload.type === "video" ? payload.type : null;
    prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  }
  if (type !== "image" && type !== "video") return isChatAutoRoute ? null : json({ error: "INVALID_MEDIA_TYPE", message: "Choose image or video generation." }, 400);
  if (type === "video") {
    return json({
      error: "LONG_FORM_VIDEO_PIPELINE_NOT_READY",
      message: "The legacy 5–8 second clip generator has been retired. Full-length creator video generation is not enabled yet. No provider request was sent and no video credits were consumed.",
    }, 503);
  }
  if (!prompt || prompt.length > 1800) return json({ error: "INVALID_PROMPT", message: "Please keep image/video prompts between 1 and 1,800 characters." }, 400);
  if (!privateGatewayConfigured) {
    return json({
      error: "PROVIDER_NOT_CONFIGURED",
      message: "Image generation needs a configured private CodeForge gateway with an enabled image model. Cloudflare is only a fallback and cannot be used as the primary provider.",
    }, 503);
  }
  if (!configuredGatewayImageModel(runtimeEnv)) {
    return json({
      error: "IMAGE_MODEL_NOT_CONFIGURED",
      message: "Image generation is paused until an administrator pins a reviewed gateway image model and verifies its pricing. No image provider request or quota reservation was made.",
    }, 503);
  }
  if (!allowMediaRequest(session.user.id, type)) {
    return json({ error: "MEDIA_RATE_LIMITED", message: "Too many media requests in a short period. Please wait a minute before trying again." }, 429, { "retry-after": "60" });
  }

  const providerPrompt = enhanceMediaPrompt(prompt, type);
  if (type === "image") {
    const suppliedKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const idempotencyKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedKey)
      ? suppliedKey
      : crypto.randomUUID();
    let reservation: UsageReservationDecision;
    try {
      reservation = await reserveUsageQuota(runtimeEnv, session.user.id, "image_generation", idempotencyKey);
    } catch {
      return json({
        error: "IMAGE_USAGE_UNAVAILABLE",
        message: "Dhwani could not reserve your image allowance. No image provider request was sent.",
      }, 503);
    }

    if (!reservation["allowed"]) {
      if (reservation["error"] === "IDEMPOTENCY_KEY_REUSED") {
        return json({
          error: "IMAGE_REQUEST_ALREADY_PROCESSED",
          message: "This image request has already been submitted. Start a new request to generate another image.",
        }, 409);
      }
      if (reservation["error"] !== "MONTHLY_LIMIT_REACHED") {
        return json({
          error: "IMAGE_USAGE_UNAVAILABLE",
          message: "Image usage limits could not be verified. No image provider request was sent.",
        }, 503);
      }
      const limit = reservation["limit"] ?? 0;
      const used = reservation["used"] ?? 0;
      const message = limit === 0
        ? "Image generation is not included in your current plan."
        : "You have used " + used + " of " + limit + " monthly image generations.";
      return json({
        error: "PLAN_LIMIT_REACHED",
        feature: "image_generation",
        planCode: reservation["planCode"] ?? "free",
        limit,
        used,
        remaining: 0,
        message: message + " Upgrade your Dhwani plan to generate more images.",
      }, 402);
    }

    const reservationId = reservation["reservationId"];
    if (!reservationId) {
      console.error("[Dhwani AI] Image quota reservation was allowed without a reservation ID.");
      return json({
        error: "IMAGE_USAGE_UNAVAILABLE",
        message: "Dhwani could not verify the image allowance reservation. No provider request was sent.",
      }, 503);
    }

    let generated: Response;
    try {
      generated = await generateImageWithFallback(providerPrompt, runtimeEnv, session.accessToken ?? "");
    } catch {
      const released = await finalizeImageQuotaReservation(runtimeEnv, session.user.id, reservationId, "release");
      return json({
        error: "IMAGE_PROVIDER_UNAVAILABLE",
        message: released
          ? "Image generation could not be completed. Your reserved image allowance has been returned."
          : "Image generation could not be completed and its temporary allowance reservation could not be released. It expires automatically within 15 minutes.",
      }, released ? 502 : 503);
    }

    if (!generated.ok || !(generated.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
      const released = await finalizeImageQuotaReservation(runtimeEnv, session.user.id, reservationId, "release");
      if (!released) {
        return json({
          error: "IMAGE_QUOTA_RELEASE_FAILED",
          message: "The image provider did not return a usable image. Its temporary quota reservation expires automatically within 15 minutes.",
        }, 503);
      }
      return generated;
    }

    const committed = await finalizeImageQuotaReservation(runtimeEnv, session.user.id, reservationId, "commit");
    if (!committed) {
      return json({
        error: "IMAGE_QUOTA_FINALIZATION_FAILED",
        message: "Dhwani could not confirm the image usage record, so the generated image was not delivered. The temporary reservation expires automatically within 15 minutes.",
      }, 503);
    }
    return generated;
  }

  // Video generation is disabled above until the asynchronous job pipeline is ready.
  return json({
    error: "LONG_FORM_VIDEO_PIPELINE_NOT_READY",
    message: "Video generation is not enabled on this media route yet. No provider request was sent and no video credits were consumed.",
  }, 503);
}
