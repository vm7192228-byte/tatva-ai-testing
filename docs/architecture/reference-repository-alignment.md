# Reference repository and UI stack alignment

Review date: 2026-11-03  
Scope: architecture patterns for CodeForge AI Workbench. This is a design comparison, not a source-code import.

## Backend and agent architecture

| Reference | Useful pattern observed | CodeForge mapping and decision |
| --- | --- | --- |
| [Dify](https://github.com/langgenius/dify) | Agent runners separate the agent loop from tool runtimes. Tool invocation receives an explicit run context (tenant, app, user and invocation source); agent/tool observations can be persisted; tool schemas are derived from runtime parameters. The current Agent node supports function-calling and ReAct-style strategies. | CodeForge already has a server-owned tool registry, provider-specific schema adapters, bounded rounds/calls, per-request user context, validation, activity events, durable generation records and approval persistence. Keep this small serverless tool engine for chat. A graph workflow engine, reusable agent catalogue, sandbox and per-node outputs are a separate feature—not something to import wholesale into this PR. |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | Authentication, request-origin policy, rate limits, tenant context and abort handling are separate middleware/services. Its routes use explicit JWT and same-origin middleware where required; owned generation aborts are resolved against the authenticated user. | CodeForge uses Supabase-backed server sessions, same-origin checks, owner-scoped generation/video/approval records and explicit status transitions. Continue keeping provider credentials server-side and every action owner-scoped. The supplied `danny-avila/LibreChat` URL redirects; the canonical repository is now `LibreChat-AI/LibreChat`. |
| [Open WebUI](https://github.com/open-webui/open-webui) | Audio configuration separates STT, TTS and realtime. Its realtime WebSocket has connection-local protocol state, an allow-list of client commands and bounded event/audio payloads. The browser recording flow owns capture, visualization, cancellation and cleanup. | CodeForge retains its existing MediaRecorder + Web Audio gain-node design: the microphone remains open during a voice session and software gain handles the AI-speaking mute. The new session identifier prevents stale transcription results crossing sessions; client abort now propagates to the server-side provider request, stopping backup-model retries after the user ends the turn. A full realtime WebSocket transport is not required for this incremental fix. |
| [Open-Higgsfield-AI](https://github.com/Autom8AI/Open-Higgsfield-AI) | Separate studios and model-specific controls are useful UI ideas. The repository's browser-stored provider credential and long client polling are not suitable patterns for CodeForge. | The previous detailed audit remains in [open-higgsfield-reference-audit.md](./open-higgsfield-reference-audit.md). CodeForge keeps credentials server-side, durable jobs and bounded owner-scoped status checks. |

## UI and component stack

| Reference | Current CodeForge state | Decision |
| --- | --- | --- |
| [shadcn/ui](https://ui.shadcn.com) | Already configured in `components.json`; reusable components are present under `src/components/ui`, with Radix primitives and supporting utilities in the dependency set. | Do not reinstall or create a second component layer. Reuse the existing components for React/TanStack surfaces, preserving the established theme and accessibility behavior. |
| [Tailwind CSS](https://tailwindcss.com) | Tailwind CSS 4 and the Vite integration are already dependencies. Existing CodeForge chat styling also includes scoped CSS in `public/codeforge/styles.css`. | Avoid a Tailwind version/configuration migration in this backend PR. Use the existing CSS variables and utilities when a discrete UI surface is changed. |
| [Vercel v0](https://v0.dev) | A UI/code-generation tool, not a runtime dependency or component library. Generated React output may assume shadcn components, aliases and additional packages. | Use only as a design/code drafting aid. Review imports, props, accessibility, responsive behavior, bundle cost and style conflicts before copying generated code. Do not create a separate Vercel project or deployment from generated output. |

## Changes made from this review

- Chat failover stops trying another provider after a tool-execution activity or approval has been emitted, preventing a provider retry from duplicating a side effect.
- Calculator exponent precedence now follows standard arithmetic rules, with negative and chained exponent cases covered by regression tests.
- Project ZIP output redacts additional common provider credential formats.
- Voice capture now deduplicates concurrent microphone starts, invalidates stale session callbacks and aborts an in-flight transcription when the voice session stops.
- The transcription API combines the client request signal with its provider timeout. An aborted client request is treated as cancellation and does not advance to backup transcription models.

## Explicitly not changed

- No reference repository was copied or vendored into CodeForge.
- No Production deployment, PR merge, Production Supabase migration or live social/video action was performed.
- No new model provider, paid media provider, long-running worker or realtime voice WebSocket was enabled.
- No wholesale migration of the existing chat surface to React/shadcn was attempted.

The next UI pass should be a separate, scoped change to one React/TanStack surface at a time; the existing browser chat surface and its voice lifecycle should not be rewritten as a side effect of backend tool work.
