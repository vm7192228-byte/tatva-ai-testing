import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";
import { codeforgeMarkup } from "@/lib/codeforge-markup";
import { Route as RootRoute } from "../routes/__root";

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });
  
  it("describes provider processing and account/device chat storage accurately", () => {
    expect(codeforgeMarkup).toContain("When you send a message, its conversation context is sent to the selected AI provider");
    expect(codeforgeMarkup).toContain("Signed-in conversations are saved to your Dhwani account. Guest conversations are stored in this browser.");
    expect(codeforgeMarkup).not.toContain("Nothing is sent to an AI provider in this preview.");
    expect(codeforgeMarkup).not.toContain("This prototype keeps conversation messages in the current page session only.");
  });

  it("uses Dhwani branding in document metadata", () => {
    const rootOptions = (RootRoute as unknown as {
      options: { head?: () => { meta?: Array<Record<string, unknown>> } };
    }).options;
    const meta = rootOptions.head?.().meta ?? [];
    expect(meta).toContainEqual(expect.objectContaining({ name: "author", content: "Dhwani AI" }));
    expect(meta.some(item => item["name"] === "twitter:site" && item["content"] === "@Lovable")).toBe(false);
  });
});
