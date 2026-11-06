<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- The imported CodeForge AI starter runs as-is: markup in src/lib/codeforge-markup.ts rendered by src/routes/index.tsx, with original script/styles/logo served from public/codeforge/. Why: keeps the uploaded app's behavior identical without a rewrite.
- Social connectors (YouTube/Facebook/Instagram) live in src/lib/social-api.server.ts under /api/social/*, storing OAuth tokens in encrypted HttpOnly cookies. Why: works on Vercel without a database until the user's own backend is connected.
