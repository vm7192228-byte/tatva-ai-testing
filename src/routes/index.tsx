import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { codeforgeMarkup } from "@/lib/codeforge-markup";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dhwani AI" },
      { name: "description", content: "Dhwani AI — a simple workspace to chat, think, build, and connect your tools." },
      { property: "og:title", content: "Dhwani AI" },
      { property: "og:description", content: "A simple workspace to chat, think, build, and connect your tools." },
      { name: "theme-color", content: "#ffffff" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Tiro+Devanagari+Hindi&family=Outfit:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap" },
      { rel: "stylesheet", href: "/codeforge/styles.css" },
      { rel: "stylesheet", href: "/codeforge/video-studio.css" },
      { rel: "stylesheet", href: "/codeforge/tatv-theme.css" },
      { rel: "stylesheet", href: "/codeforge/dhwani-ui.css?v=claude-clean-3" },
      { rel: "icon", type: "image/svg+xml", href: "/dhwani/dhwani-mark.svg" },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    if (!document.documentElement.dataset["theme"]) {
      let saved: string | null = null;
      try { saved = localStorage.getItem("codeforge-ai-theme"); } catch { /* storage unavailable */ }
      const dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset["theme"] = dark ? "dark" : "light";
    }
    const s = document.createElement("script");
    s.type = "module";
    s.src = `/codeforge/app.js?t=${Date.now()}`;
    document.body.appendChild(s);
    const github = document.createElement("script");
    github.type = "module";
    github.src = `/codeforge/github-client.js?t=${Date.now()}`;
    document.body.appendChild(github);
    return () => { s.remove(); github.remove(); };
  }, []);
  return <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: codeforgeMarkup }} />;
}
