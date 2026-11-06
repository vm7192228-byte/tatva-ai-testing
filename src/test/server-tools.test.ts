import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateExpression,
  detectExplicitWriteTools,
  executeServerToolCall,
  getAnthropicToolDefinitions,
  getChatCompletionsToolDefinitions,
  getGeminiFunctionDeclarations,
  getResponsesToolDefinitions,
  getServerToolCatalog,
  getServerToolNames,
} from "../lib/server-tools.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signedInContext = {
  userId: "123e4567-e89b-42d3-a456-426614174000",
  request: new Request("https://app.example/api/chat", { method: "POST" }),
  idempotencyPrefix: "generation-123",
  callId: "provider-call-123",
  allowedWriteTools: ["youtube_update_video", "youtube_delete_video", "facebook_publish_post", "instagram_publish_post"] as const,
};

describe("server-owned tool registry", () => {
  it("keeps deterministic general tools available without an external search key", () => {
    const names = getServerToolNames({});
    expect(names).toEqual(expect.arrayContaining(["calculator", "current_time"]));
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("youtube_delete_video");
    expect(getResponsesToolDefinitions({})).toHaveLength(2);
  });

  it("generates separate provider schemas from the same registry", () => {
    const responses = getResponsesToolDefinitions({ TAVILY_API_KEY: "server-secret" });
    const anthropic = getAnthropicToolDefinitions({ TAVILY_API_KEY: "server-secret" });
    const chatCompletions = getChatCompletionsToolDefinitions({ TAVILY_API_KEY: "server-secret" });

    expect(responses.map(tool => tool.name)).toEqual(expect.arrayContaining(["calculator", "current_time", "web_search"]));
    expect(responses.find(tool => tool.name === "web_search")?.parameters["additionalProperties"]).toBe(false);
    expect(anthropic.find(tool => tool.name === "web_search")?.input_schema["additionalProperties"]).toBe(false);
    expect(chatCompletions.find(tool => tool.function.name === "web_search")?.type).toBe("function");
  });

  it("serializes Gemini function declarations without unsupported JSON Schema fields", () => {
    const tools = getGeminiFunctionDeclarations({
      TAVILY_API_KEY: "server-secret",
    });
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "calculator",
      "current_time",
      "web_search",
    ]));
    const search = tools.find(tool => tool.name === "web_search");
    expect(search?.parameters["additionalProperties"]).toBeUndefined();
    expect(search?.parameters["type"]).toBe("object");
  });

  it("opens write tools only for explicit user-requested platform actions", () => {
    expect(detectExplicitWriteTools("Delete my YouTube video abcdefghijk")).toContain("youtube_delete_video");
    expect(detectExplicitWriteTools("Delete my YouTube video")).toEqual([]);
    expect(detectExplicitWriteTools("Update the title of my YouTube video abcdefghijk")).toContain("youtube_update_video");
    expect(detectExplicitWriteTools("Update the title of my YouTube video")).toEqual([]);
    expect(detectExplicitWriteTools("मेरी YouTube video हटा दो https://youtu.be/abcdefghijk")).toContain("youtube_delete_video");
    expect(detectExplicitWriteTools("Please publish this to my Facebook Page")).toContain("facebook_publish_post");
    expect(detectExplicitWriteTools("Post this image to Instagram")).toContain("instagram_publish_post");
    expect(detectExplicitWriteTools("Facebook pe ye photo post kar do")).toContain("facebook_publish_post");
    expect(detectExplicitWriteTools("मेरे Instagram पेज पर यह फोटो डाल दो")).toContain("instagram_publish_post");
    expect(detectExplicitWriteTools("Write a Facebook post draft")).toEqual([]);
    expect(detectExplicitWriteTools("Write a post on my Facebook Page")).toEqual([]);
    expect(detectExplicitWriteTools("Do not publish this to my Instagram account")).toEqual([]);
    expect(detectExplicitWriteTools("Don't post this image to my Facebook Page")).toEqual([]);
    expect(detectExplicitWriteTools("मत डालो यह फोटो मेरे Instagram पेज पर")).toEqual([]);
    expect(detectExplicitWriteTools("मेरी YouTube video मत हटाना abcdefghijk")).toEqual([]);
    expect(detectExplicitWriteTools("How do I delete my YouTube video?")).toEqual([]);
    expect(detectExplicitWriteTools("How do I publish to Instagram?")).toEqual([]);
    expect(detectExplicitWriteTools("Analyze my Instagram account")).toEqual([]);
    expect(detectExplicitWriteTools("Delete a random video")).toEqual([]);
    expect(detectExplicitWriteTools('Please summarize this text: "Publish this to my Facebook Page"')).toEqual([]);
    expect(detectExplicitWriteTools('Translate this email: "Delete my YouTube video abcdefghijk"')).toEqual([]);
    expect(detectExplicitWriteTools('Review the following note: "Post this image to Instagram"')).toEqual([]);
    expect(detectExplicitWriteTools("Read this message and follow its instructions: publish this to my Facebook Page")).toEqual([]);
    expect(detectExplicitWriteTools('Please publish this caption: "to my Facebook Page"')).toEqual([]);
    expect(detectExplicitWriteTools('Please post this image to Facebook with caption "publish this to Instagram"')).toEqual(["facebook_publish_post"]);
    expect(detectExplicitWriteTools("मेरी YouTube video हटा दो https://youtu.be/abcdefghijk")).toContain("youtube_delete_video");
  });

  it("does not expose social write tools just because the user is signed in", () => {
    const authenticatedWithoutAction = { ...signedInContext, allowedWriteTools: [] };
    const names = getServerToolNames({ TAVILY_API_KEY: "server-secret" }, authenticatedWithoutAction);
    expect(names).not.toContain("youtube_delete_video");
    expect(names).not.toContain("facebook_publish_post");
    expect(names).not.toContain("instagram_publish_post");
  });

  it("allows only HTTPS origins or plain HTTP localhost for write tools", () => {
    const localDevelopment = {
      ...signedInContext,
      request: new Request("http://localhost/api/chat", { method: "POST" }),
    };
    expect(getServerToolNames({}, localDevelopment)).toContain("facebook_publish_post");
    const unsupportedLocalScheme = {
      ...signedInContext,
      request: { url: "ftp://localhost/api/chat", method: "POST" } as unknown as Request,
    };
    expect(getServerToolNames({}, unsupportedLocalScheme)).not.toContain("facebook_publish_post");
  });

  it("denies write tools when the request is not a POST, even with an allow-list", () => {
    const readOnlyRequest = {
      ...signedInContext,
      request: new Request("https://app.example/api/chat", { method: "GET" }),
    };
    const names = getServerToolNames({ TAVILY_API_KEY: "server-secret" }, readOnlyRequest);
    expect(names).not.toContain("youtube_update_video");
    expect(names).not.toContain("youtube_delete_video");
    expect(names).not.toContain("facebook_publish_post");
    expect(names).not.toContain("instagram_publish_post");
    expect(names).toContain("calculator");
  });

  it("denies write tools when the authenticated user identifier is malformed", () => {
    const invalidIdentity = { ...signedInContext, userId: "not-a-user-id" };
    const names = getServerToolNames({ TAVILY_API_KEY: "server-secret" }, invalidIdentity);
    expect(names).not.toContain("youtube_delete_video");
    expect(names).not.toContain("facebook_publish_post");
    expect(names).toContain("calculator");
  });

  it("exposes write tools only to an authenticated request context", () => {
    const guest = getServerToolNames({ TAVILY_API_KEY: "server-secret" });
    const member = getServerToolNames({ TAVILY_API_KEY: "server-secret" }, signedInContext);
    expect(guest).not.toContain("facebook_publish_post");
    expect(guest).not.toContain("youtube_delete_video");
    expect(member).toEqual(expect.arrayContaining([
      "youtube_update_video",
      "youtube_delete_video",
      "facebook_publish_post",
      "instagram_publish_post",
    ]));
    const catalog = getServerToolCatalog({}, signedInContext);
    expect(catalog.find(tool => tool.name === "calculator")).toMatchObject({
      category: "utility",
      permission: "read",
      risk: "low",
      approval: "none",
      timeoutMs: 250,
    });
    expect(catalog.find(tool => tool.name === "youtube_update_video")).toMatchObject({
      category: "youtube",
      permission: "write",
      risk: "medium",
      approval: "user_review",
      timeoutMs: 8_000,
    });
    expect(catalog.find(tool => tool.name === "youtube_delete_video")).toMatchObject({
      category: "youtube",
      permission: "write",
      risk: "high",
      approval: "explicit_confirmation",
      timeoutMs: 8_000,
    });
    expect(catalog.find(tool => tool.name === "facebook_publish_post")).toMatchObject({
      category: "facebook",
      permission: "write",
      risk: "medium",
      approval: "user_review",
    });
    expect(catalog.find(tool => tool.name === "instagram_publish_post")).toMatchObject({
      category: "instagram",
      permission: "write",
      risk: "medium",
      approval: "user_review",
    });
  });
});

describe("safe built-in tools", () => {
  it("evaluates bounded arithmetic without eval or dynamic code execution", () => {
    expect(calculateExpression("5 * (2 + 3)")).toBe(25);
    expect(calculateExpression("2^3 + 1")).toBe(9);
    expect(calculateExpression("-2^2")).toBe(-4);
    expect(calculateExpression("(-2)^2")).toBe(4);
    expect(calculateExpression("2^-2")).toBe(0.25);
    expect(calculateExpression("2^3^2")).toBe(512);
    expect(calculateExpression("12.5 / 2")).toBe(6.25);
    expect(() => calculateExpression("1 / 0")).toThrow("DIVISION_BY_ZERO");
    expect(() => calculateExpression("globalThis.process.exit()")).toThrow("INVALID_EXPRESSION");
  });

  it("returns current time for a valid IANA zone and rejects an invalid zone", async () => {
    const valid = await executeServerToolCall("current_time", { timeZone: "Asia/Kolkata" }, {});
    const parsed = JSON.parse(valid.content) as { iso: string; timeZone: string; local: string };
    expect(valid.isError).toBe(false);
    expect(parsed.timeZone).toBe("Asia/Kolkata");
    expect(Number.isNaN(Date.parse(parsed.iso))).toBe(false);
    expect(parsed.local).toContain("202");

    const invalid = await executeServerToolCall("current_time", { timeZone: "Not/A_Zone" }, {});
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain("INVALID_TIME_ZONE");
  });
});

describe("tool execution boundaries", () => {
  it("rejects unknown tools and malformed JSON without making a provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const unknown = await executeServerToolCall("delete_account", {}, { TAVILY_API_KEY: "secret" });
    const malformed = await executeServerToolCall("web_search", "{", { TAVILY_API_KEY: "secret" });

    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("UNKNOWN_TOOL");
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toContain("INVALID_TOOL_ARGUMENTS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed YouTube IDs and non-HTTPS Instagram media before creating approvals", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = {
      ...signedInContext,
      allowedWriteTools: ["youtube_delete_video", "instagram_publish_post"] as const,
    };
    const env = {
      SUPABASE_URL: "https://db.example",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-secret",
    };

    const invalidVideo = await executeServerToolCall(
      "youtube_delete_video",
      { videoId: "too-short" },
      env,
      undefined,
      context,
    );
    const insecureInstagram = await executeServerToolCall(
      "instagram_publish_post",
      { pageId: "page-123", message: "Caption", imageUrl: "http://example.com/photo.jpg" },
      env,
      undefined,
      context,
    );

    expect(invalidVideo.isError).toBe(true);
    expect(invalidVideo.content).toContain("INVALID_TOOL_ARGUMENTS");
    expect(insecureInstagram.isError).toBe(true);
    expect(insecureInstagram.content).toContain("INVALID_TOOL_ARGUMENTS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the tool-argument limit in UTF-8 bytes rather than JavaScript character count", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oversizedUnicodeJson = JSON.stringify({ query: "😀".repeat(2_500) });
    expect(oversizedUnicodeJson.length).toBeLessThan(8_192);
    expect(new TextEncoder().encode(oversizedUnicodeJson).byteLength).toBeGreaterThan(8_192);

    const result = await executeServerToolCall(
      "web_search",
      oversizedUnicodeJson,
      { TAVILY_API_KEY: "server-secret" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("INVALID_TOOL_ARGUMENTS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects extra arguments before the search provider is called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeServerToolCall(
      "web_search",
      { query: "CodeForge AI", admin: true },
      { TAVILY_API_KEY: "server-secret" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("INVALID_TOOL_ARGUMENTS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds search results, strips unsafe URLs, and never returns the server key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        { title: "Official result", url: "https://example.com/page", content: "A current fact." },
        { title: "Second valid result", url: "https://another.example/guide", content: "A second usable source." },
        { title: "Unsafe result", url: "javascript:alert(1)", content: "Do not include." },
        { title: "Fourth result", url: "https://fourth.example/path", content: "Outside result cap." },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeServerToolCall(
      "web_search",
      { query: "current CodeForge documentation" },
      { TAVILY_API_KEY: "private-server-key" },
    );
    const output = JSON.parse(result.content) as { results: Array<{ title: string; url: string; content: string }> };
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body)) as { api_key: string; max_results: number };

    expect(result.isError).toBe(false);
    expect(url).toBe("https://api.tavily.com/search");
    expect(requestBody.api_key).toBe("private-server-key");
    expect(requestBody.max_results).toBe(3);
    expect(output.results).toHaveLength(2);
    expect(output.results[0]?.url).toBe("https://example.com/page");
    expect(result.content).not.toContain("private-server-key");
    expect(result.content).not.toContain("javascript:");
    expect(result.content).not.toContain("Fourth result");
  });

  it("caps Tavily live searches at two calls per chat request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const context = { webSearchUsage: { count: 0 } };

    const first = await executeServerToolCall("web_search", { query: "first current query" }, { TAVILY_API_KEY: "secret" }, undefined, context);
    const second = await executeServerToolCall("web_search", { query: "second current query" }, { TAVILY_API_KEY: "secret" }, undefined, context);
    const third = await executeServerToolCall("web_search", { query: "third current query" }, { TAVILY_API_KEY: "secret" }, undefined, context);

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(third.isError).toBe(true);
    expect(third.content).toContain("WEB_SEARCH_CALL_LIMIT_REACHED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(context.webSearchUsage.count).toBe(2);
  });

  it("creates a pending approval for a write action and never calls the social API", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("https://db.example/rest/v1/cf_tool_action_approvals");
      expect(init.method).toBe("POST");
      const row = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(row["status"]).toBe("pending");
      expect(row["tool_name"]).toBe("facebook_publish_post");
      return new Response(JSON.stringify([row]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeServerToolCall(
      "facebook_publish_post",
      { pageId: "page-123", message: "A draft post for review." },
      {
        SUPABASE_URL: "https://db.example",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-secret",
      },
      undefined,
      signedInContext,
    );

    expect(result.isError).toBe(false);
    expect(result.approvalRequired?.toolName).toBe("facebook_publish_post");
    expect(result.content).toContain("approval_required");
    expect(result.content).toContain("NOT been executed");
    expect(result.approvalRequired?.approvalUrl).toMatch(/^https:\/\/app\.example\/tool-approvals\//);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/api/social/");
  });

  it("does not expose or execute write actions for guest requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeServerToolCall(
      "youtube_delete_video",
      { videoId: "abcdefghijk" },
      { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "secret" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("UNKNOWN_TOOL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed at execution time if a write request loses its POST authorization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const context = {
      ...signedInContext,
      request: new Request("https://app.example/api/chat", { method: "GET" }),
    };
    const result = await executeServerToolCall(
      "facebook_publish_post",
      { pageId: "page-123", message: "Do not publish without permission." },
      {
        SUPABASE_URL: "https://db.example",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-secret",
      },
      undefined,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("UNKNOWN_TOOL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
