# External AI and browser-connector repository review

Review date: 4 November 2026  
Target: `vmmishra737-cell/codeforge-ai-workbench`  
Scope: source review and safe integration decisions for the two referenced public repositories.

## Decision summary

| Reference | What it actually provides | Workbench decision |
| --- | --- | --- |
| `goodnight000/api-anything` | Local-first browser-traffic learning toolkit, CLI, library and stdio MCP server | Do not run it inside Vercel or proxy user browser sessions through the Workbench backend. Reserve a separate, user-controlled local companion design. |
| `the supplied Qwen local-installer repository` | Installer and serving harness for local Ollama/MLX model use; it does not contain the model weights or inference engine | Do not integrate the supplied repository's safety-bypassing checkpoint. The Workbench adds an optional adapter only for the official `Qwen/Qwen3.8-27B` base model on an authenticated HTTPS OpenAI-compatible endpoint. |

No code from either external repository is vendored. No third-party credentials, browser cookies, model weights, or inference infrastructure are added by this change.

## 1. API Anything — local companion, not a hosted Workbench API

The reviewed repository declares version `0.3.2`, MIT license, Node `>=22.13.0`, and a stdio MCP entry point. Its architecture learns parameterized operations from browser/network traffic and can call those operations through its CLI, library or MCP server.

Important operational boundaries from its own documentation and source:

- Site specifications, login sessions and browser profile data are stored on the machine running API Anything (by default under `~/.api-anything`, configurable with `API_ANYTHING_HOME`).
- Learning and browser-tier operations open a local Chromium/Chrome browser. The MCP process communicates over stdio; it is not a hosted HTTPS REST service.
- Its host integration plans operations locally and can bind an approval to a fingerprint. A write operation is refused unless the host explicitly enables it.
- Its registry/share system is not a guarantee that arbitrary websites, endpoints or browser operations are available. Operations are learned and verified individually; repair can fail.
- The CLI has write-capable features behind explicit flags. Workbench must not enable or expose those automatically.

### Why it is not embedded in a Vercel function

The Workbench server runs in a shared cloud runtime. Running API Anything there would move website sessions and browser cookies away from the user's own machine, would not see the user's everyday browser profile, and would collapse the isolation boundary that API Anything's local-first design relies on. Spawning a stdio MCP server from a serverless request is also not a durable or appropriate substitute for a per-user local process.

### Safe future integration shape

A future connector should be a separately installed, user-controlled local companion:

1. The user explicitly installs and starts the companion on their own computer under their own operating-system account.
2. The companion owns its own browser profile, API Anything home directory, sessions and permissions. Workbench never receives raw browser cookies or login credentials.
3. The initial Workbench connector exposes only a narrow, allowlisted set of read operations. There is no arbitrary URL fetch or arbitrary JavaScript execution endpoint.
4. Each operation is previewed with its domain, operation, arguments and redacted request. Writes remain unavailable until a separate design adds per-action user confirmation and a read-back check.
5. The local bridge uses authenticated, short-lived, per-user pairing; strict origin checks; replay protection; bounded payloads/timeouts; and an explicit disconnect/revoke control.
6. Browser traffic, learned specs and returned site content are untrusted data. They cannot modify agent instructions or select new tools.

This companion is a separate product/security task. No fake “API Anything connected” status is shown in the Workbench UI.

## 2. Qwen — official model adapter, not the uncensored fork

The reviewed `qwen38-uncensored` repository is an installation and serving harness. It invokes external Ollama or MLX tooling and downloads model weights separately; it does not bundle the Qwen inference engine or the model bytes. Its README and Modelfile explicitly distinguish official weights from a third-party abliterated/uncensored checkpoint.

The Workbench does **not** integrate or serve the abliterated/uncensored checkpoint. That variant is designed to weaken model safeguards, so it is outside the supported integration.

Instead, the Workbench adds an opt-in provider adapter for the official base model ID:

- Model: `Qwen/Qwen3.8-27B`
- API shape: authenticated OpenAI-compatible `/v1/chat/completions`
- Base URL: `QWEN_BASE_URL`
- Server-only credential: `QWEN_API_KEY`
- Optional tool-call gate: `QWEN_ENABLE_TOOLS=false` by default
- Current provider access: Plus/Max direct-provider plan gate and the existing chat usage ledger
- Current input support: text only; the existing Gemini route continues to handle inline image, PDF, audio and video attachments.
- Current Qwen tool loop: disabled by default. Enable only after the inference server has the matching Qwen `qwen3_coder` parser and the Workbench approval flow is validated end-to-end.

The provider uses the existing streaming adapter and the Workbench server's system instruction. It does not switch the default model away from Dhwani Smart/Gemini and does not add any client-side API key.

### Hosting and operational requirements

Qwen 27B is a large model. Inference needs a separate model-serving host with appropriate GPU memory, model storage, compute capacity and monitoring. Vercel serverless functions are only the Workbench API adapter; they do not download or host the model weights.

Use an HTTPS endpoint behind an authenticated reverse proxy. Never expose an unauthenticated inference server to the public internet. Keep the Qwen API key exclusively in server-side Vercel environment variables. A desktop Ollama/MLX process running on `127.0.0.1` is not reachable from Vercel; a later local-companion design would be required for local desktop inference.

Credential detection is not a health check. The provider is not considered live until a real request to the configured model host succeeds. No Qwen endpoint or secret was supplied in this change, so live inference has not been claimed or tested.

## 3. Environment variables added

```dotenv
QWEN_BASE_URL=https://YOUR_SECURED_QWEN_INFERENCE_HOST
QWEN_API_KEY=YOUR_QWEN_REVERSE_PROXY_API_KEY
QWEN_ENABLE_TOOLS=false
```

The URL validator requires HTTPS and rejects embedded credentials, query strings and fragments. The server appends `/v1` when the supplied base URL does not already end with that path. Secrets are never returned by the provider readiness endpoint.

Do not add these values to a `VITE_*` variable, the browser bundle, local storage, a chat message, or a public repository.

## 4. Verification scope

Automated tests cover provider status without leaking secrets, HTTPS-only URL acceptance, the Plus/Max provider gate, request authentication, model selection, the Qwen thinking parameter and streamed output normalization.

These tests use a mocked OpenAI-compatible endpoint. They do not prove that an inference machine exists, that its model is loaded, that it has enough GPU memory, or that a live Qwen request succeeds. A real authenticated Preview smoke test is still required after a secured inference endpoint is configured.

## References

- API Anything source: https://github.com/goodnight000/api-anything
- Official Qwen model: https://huggingface.co/Qwen/Qwen3.8-27B
- Official Qwen serving guide: https://github.com/QwenLM/Qwen3.8
- vLLM OpenAI-compatible server: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
