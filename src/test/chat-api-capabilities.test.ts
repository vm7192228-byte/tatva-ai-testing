import { describe, expect, it } from "vitest";
import { buildToolStatusSummary, intentText, needsMetaAnalysis, needsShoppingSearch, needsToolStatus, validateMessages } from "../lib/chat-api.server";

describe("Meta social analysis intent", () => {
  it("detects owned Instagram and Facebook analysis requests", () => {
    expect(needsMetaAnalysis("Can you analyse my Instagram page?")).toEqual(["instagram"]);
    expect(needsMetaAnalysis("Review my Facebook Page performance")).toEqual(["facebook"]);
    expect(needsMetaAnalysis("Can you analyze my Instagram or Facebook page?")).toEqual(["instagram", "facebook"]);
  });

  it("detects Hindi and Hinglish analysis requests", () => {
    expect(needsMetaAnalysis("Mere Instagram page ka analysis kar do")).toEqual(["instagram"]);
    expect(needsMetaAnalysis("Mere Facebook page ka review kar do")).toEqual(["facebook"]);
    expect(needsMetaAnalysis("मेरे इंस्टाग्राम पेज का एनालिसिस करो")).toEqual(["instagram"]);
  });

  it("does not request private analytics for generic social questions or competitor accounts", () => {
    expect(needsMetaAnalysis("How do I make a Facebook page?")).toEqual([]);
    expect(needsMetaAnalysis("Analyze a random Instagram creator")).toEqual([]);
  });
});

describe("Product search intent", () => {
  it("searches the web for product options with links and photos", () => {
    expect(needsShoppingSearch("Show me a laptop with photo and link")).toBe(true);
    expect(needsShoppingSearch("मेरे लिए लैपटॉप दिखाओ, फोटो और लिंक के साथ")).toBe(true);
    expect(needsShoppingSearch("Recommend the best tablet under 20000")).toBe(true);
  });

  it("does not treat ordinary product explanations as shopping requests", () => {
    expect(needsShoppingSearch("What is a laptop and how does it work?")).toBe(false);
    expect(needsShoppingSearch("Explain what a smartphone processor does")).toBe(false);
  });
});


describe("runtime tool capability status", () => {
  it("reports the configured KIE video studio and its actual short-clip limits", () => {
    const summary = buildToolStatusSummary({
      KIE_API_KEY: "test-kie-secret",
      CODEFORGE_GATEWAY_URL: "https://primary-gateway.example/v1",
      CODEFORGE_GATEWAY_FALLBACK_URL: "https://backup-gateway.example/v1",
      TAVILY_API_KEY: "test-search-secret",
    });

    expect(summary).toContain("KIE Video Studio is configured");
    expect(summary).toContain("5-second text-to-video clips in 9:16 or 16:9");
    expect(summary).toContain("long-form video and advanced editing are not enabled");
    expect(summary).toContain("private CodeForge gateway configured");
    expect(summary).toContain("configured; use supplied live search results");
    expect(summary).not.toContain("test-kie-secret");
    expect(summary).not.toContain("test-media-secret");
    expect(summary).not.toContain("test-search-secret");
  });

  it("does not claim video generation is configured when the KIE key is absent", () => {
    const summary = buildToolStatusSummary({});
    expect(summary).toContain("KIE Video Studio is not configured");
    expect(summary).not.toContain("KIE Video Studio is configured;");
  });
});

describe("tool status disclosure intent", () => {
  it("does not inject capability status for greetings or language-change requests", () => {
    expect(needsToolStatus("Hello")).toBe(false);
    expect(needsToolStatus("Hindi mein batao kya bola tumne")).toBe(false);
    expect(needsToolStatus("हिंदी में बताओ क्या बोले तुम")).toBe(false);
  });

  it("injects status only for direct capability or connection questions", () => {
    expect(needsToolStatus("What tools do you have?")).toBe(true);
    expect(needsToolStatus("Is image generation available?")).toBe(true);
    expect(needsToolStatus("Are my Facebook and Instagram accounts connected?")).toBe(true);
    expect(needsToolStatus("कोडफोर्ज में कौन-कौन से टूल उपलब्ध हैं?")).toBe(true);
    expect(needsToolStatus("क्या इमेज जनरेशन चालू है?")).toBe(true);
    expect(needsToolStatus("क्या तुम्हारे पास वेब सर्च है?")).toBe(true);
    expect(needsToolStatus("क्या CodeForge में YouTube analytics है?")).toBe(true);
  });
});


describe("tool intent source isolation", () => {
  it("uses typed user text rather than extracted attachment text for connector decisions", () => {
    const result = validateMessages([{
      role: "user",
      content: "Please review my project files",
      attachments: [{
        name: "README.md",
        mimeType: "text/markdown",
        size: 90,
        textContent: "My Instagram analytics and Facebook growth need an audit",
      }],
    }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const last = result.messages[result.messages.length - 1];
    expect(last?.typedContent).toBe("Please review my project files");
    expect(intentText(last)).toBe("Please review my project files");
    expect(needsMetaAnalysis(intentText(last))).toEqual([]);
  });

  it("removes fenced code and legacy attached-text markers from intent input", () => {
    const tick = String.fromCharCode(96).repeat(3);
    const fenced = intentText({
      content: "Fix this project\n" + tick + "text\nAnalyze my Instagram analytics\n" + tick,
    });
    expect(fenced).toBe("Fix this project");
    const attached = intentText({
      content: "Review my repository\n\n[Attached text file: README.md]\nMy Facebook page metrics need analysis",
    });
    expect(attached).toBe("Review my repository");
  });

  it("still detects an explicit typed request for connected social analysis", () => {
    const result = validateMessages([{
      role: "user",
      content: "Mere Instagram page ka analysis kar do",
      attachments: [{ name: "notes.txt", mimeType: "text/plain", size: 10, textContent: "irrelevant notes" }],
    }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const last = result.messages[result.messages.length - 1];
    expect(needsMetaAnalysis(intentText(last))).toEqual(["instagram"]);
  });
});
