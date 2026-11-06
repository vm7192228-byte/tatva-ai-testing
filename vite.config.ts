// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { workflow } from "workflow/vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const isVercelBuild = process.env["VERCEL"] === "1";

export default defineConfig({
  // Workflow transforms run only in Vercel builds. Cloudflare's experimental
  // deployment keeps its existing build target and does not start these jobs.
  vite: {
    plugins: isVercelBuild ? [workflow()] : [],
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    server: { entry: "server" },
  },
  ...(isVercelBuild
    ? {
        nitro: {
          preset: "vercel",
        },
      }
    : {}),
});
