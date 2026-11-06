# Direct AI provider setup

CodeForge keeps provider credentials on the server. Never place these values in browser JavaScript, a `VITE_*` variable, source control, or a client-side request body.

## Provider credentials and defaults

| Provider | Server credential | Default model | API route |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-6.1-sol` | `https://api.openai.com/v1/responses` |
| Claude / Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | `https://api.anthropic.com/v1/messages` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` | `https://api.deepseek.com/chat/completions` |
| Grok / xAI | `XAI_API_KEY` | `grok-4.7` | `https://api.x.ai/v1/responses` |

Model defaults can be overridden server-side with `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `DEEPSEEK_MODEL`, or `XAI_MODEL`.

Optional provider controls:

- `DEEPSEEK_THINKING`: `enabled` or `disabled`; defaults to `disabled`.
- `XAI_REASONING_EFFORT`: `low`, `medium`, `high`, or `xhigh`; defaults to `low`.

## Streaming and recovery

- OpenAI and Grok use the Responses API. CodeForge forwards output-text deltas and waits for a response completion event before marking the answer complete.
- Claude uses the Messages API. CodeForge forwards `text_delta` content and requires `message_stop`; a `max_tokens` stop is reported as an incomplete response.
- DeepSeek uses its OpenAI-compatible Chat Completions stream. CodeForge handles content deltas, finish reasons, and `[DONE]`.
- Authentication, permission, billing, invalid-request, rate-limit, overload, and timeout failures are converted into user-safe errors. Provider response bodies and credentials are not sent to the browser.
- User cancellation and request timeouts are passed through to the upstream fetch and stream.

## Tatv Smart uses only privately operated CodeForge gateways for Tattv's multi-user traffic.

**Gemini API is disabled in the Workbench provider preflight.** The current Gemini API Additional Terms (effective March 23, 2026) require the API operator to be 18+ and prohibit API Clients that are directed toward or likely to be accessed by under-18s. Do not enable Gemini directly, through the public gateway's model pool, or through the private gateway for this learner-facing service. Do not submit private or sensitive content to any unpaid provider service. Reassess only if the product's audience and operator eligibility genuinely meet the current provider terms.

1. **Primary — private CodeForge gateway:** configure `CODEFORGE_GATEWAY_URL` and optionally `CODEFORGE_GATEWAY_MODEL`.
2. **Secondary — independent private CodeForge instance:** configure `CODEFORGE_GATEWAY_FALLBACK_URL` and optionally `CODEFORGE_GATEWAY_FALLBACK_MODEL`. It must be independently deployed and healthy; pointing both variables at the same instance does not provide redundancy.

Both gateways must validate the signed-in user's Supabase access token (signature, issuer, audience and expiry) and derive the user ID only from the verified JWT subject. Each must use the Workbench staging Supabase issuer for Preview, and the correct issuer for its respective deployment. The Workbench never forwards a shared administrator token as a user credential. Keep `ADMIN_ACCESS_TOKEN`, database passwords, provider keys and service-role keys strictly inside the gateway deployment. Do not put them in Workbench browser code or the user's Bearer token.

For Smart requests, the server attempts the private primary first and the independent private fallback second. Automatic failover is limited to transient upstream failures, rate limits, timeouts, network interruptions, and explicit pre-answer protocol incompatibility. Authentication, permission, billing, invalid-model/request and provider-policy errors remain visible. A request is never replayed after answer text, a tool execution or an approval side effect starts. Workbench plan/quota reservations remain authoritative for Tattv product limits; each private gateway independently enforces its own per-user request/token/provider budgets as a second safety layer.

The public FreeLLMAPI repository explicitly describes its proxy as single-user and for personal experimentation, not a production multi-tenant API. Its MIT code license does not grant rights to pool upstream free quotas or override the terms of each provider. Therefore the public Unified endpoint/key must not be routed to Tattv alpha testers or business users. Keep it for local owner experimentation only, outside the Tattv request path.

The private CodeForge gateway's own PostgreSQL catalog is administered separately from the Workbench database. Add approved upstream provider credentials through the private gateway admin dashboard, sync/import the provider's models, review model capability/pricing/limits, and explicitly enable only suitable models. A healthy `/healthz` endpoint does not prove that a chat/image/video model is enabled or that an authenticated inference request succeeds.

Before inviting testers, verify both configured gateways with a real signed-in request, ensure the JWT issuer is correct for Preview, confirm at least one enabled chat model and provider credential in the private catalog, and check the per-user token/request limits. Before enabling image or video, separately verify the gateway's image/video model catalogs and confirm that Workbench plan quotas and gateway media quotas do not conflict.

**Do not add advertised free-token totals from separate providers as a guaranteed pooled business quota.** Provider account limits, commercial permissions, model availability, rate limits and pricing remain controlled by each upstream provider. The private gateway gives you control over routing, provider selection, per-user quotas and observability; it does not create free inference capacity.

## Provider billing versus CodeForge plans

A detected API key means only that a server-side credential is present. It does not prove the provider account is active, has model access, has remaining balance, or will accept the selected model. The first real request is the actual access check.

ChatGPT Free/Plus/Pro subscriptions and the OpenAI API platform use separate billing systems. Claude Free/Pro subscriptions and the Anthropic API Console are also separate products. A consumer chat subscription does not automatically provide API usage for CodeForge. Check the linked provider account's API billing and model pricing before enabling a provider. DeepSeek usage is token-priced and its currently documented model catalog should be checked before changing the model ID.

CodeForge's own chat allowances are separate from provider billing:
- Free: signed-in accounts can use Tatv Smart through the private CodeForge gateway, subject to Workbench request limits and the gateway's per-user token/request budgets. Guest Smart chat is disabled for the private alpha until a separate anonymous identity and per-guest quota design is implemented. Gemini API is disabled for this release.
- Plus: 300 monthly Super Chats across Smart and direct paid chat providers.
- Max: unlimited Super Chats in the CodeForge plan ledger.
- Direct OpenAI, Claude, DeepSeek, Grok, Cloudflare and Pollinations selections require Plus or Max. Provider API charges, credits, rate limits and model access remain separate.

Do not describe provider credentials as live-ready until a real request succeeds. Never expose provider secrets to the browser.

## Consumer free tiers are not API quotas

The consumer apps and their developer APIs are separate products:
- ChatGPT Free currently documents unlimited everyday text chats subject to abuse-prevention safeguards. File uploads, image generation, voice, data analysis and other tools have separate limits. OpenAI's consumer plan does not include transferable OpenAI API credits.
- Claude Free is described as limited usage. Anthropic does not publish one fixed number of messages that applies to every account and task; usage may depend on capacity and the task. A Claude Free/Pro subscription does not include Anthropic Console API usage.
- DeepSeek's API model usage is token-priced; do not assume the consumer app's availability or limits apply to API calls.
- Grok API access and billing are governed by the xAI API account, key, model access and current API pricing—not by a consumer Grok subscription.

CodeForge must not copy or promise another company's exact consumer quota. Its own server-enforced allowances are:
| CodeForge plan | Chat allowance | Image generation | File/PDF analysis | Social analysis / edit actions |
| --- | --- | --- | --- | --- |
| Free | No monthly Super Chat cap; provider fair-use and request-rate protection apply | 2/month | 3/month | 3 analyses and 1 action/month |
| Plus ₹499 | 300 Super Chats/month | 20/month | Included (unlimited in the plan ledger) | Unlimited |
| Max ₹1,999 | Unlimited Super Chats | 60/month | Included (unlimited in the plan ledger) | Unlimited |

The Workbench chat limiter is 6 requests per minute for guests and 15 per minute for signed-in accounts. For this private alpha, only signed-in accounts can use Tatv Smart; the private gateway independently enforces per-user request and monthly token budgets. Guest Smart chat remains disabled until a separate anonymous JWT identity and per-guest budget are in place. Gemini API is disabled in this release, and the public FreeLLMAPI endpoint is not used for Tattv traffic. Full-length video generation is also disabled; do not show or consume legacy 5–8 second credits.

## Current model IDs and references

Defaults in this branch use OpenAI `gpt-6.1-sol`, Claude `claude-sonnet-5-5`, DeepSeek `deepseek-flash`, and Grok `grok-4.7`. These are defaults, not a promise that every API account has access. The provider's live model list and account entitlements remain authoritative.

Official references:
- OpenAI model catalogue: https://developers.openai.com/api/docs/models
- OpenAI API and ChatGPT billing separation: https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform
- Anthropic model catalogue: https://platform.claude.com/docs/en/models/overview
- Anthropic Claude plan and API billing separation: https://support.anthropic.com/en/articles/9876003-i-subscribe-to-a-paid-claude-ai-plan-why-do-i-have-to-pay-separately-for-api-usage-on-console
- DeepSeek model pricing and IDs: https://api-docs.deepseek.com/quick_start/pricing/
- xAI model catalogue: https://docs.x.ai/developers/models

## Access and supported input

Direct OpenAI, Claude, DeepSeek, Grok, Cloudflare and Pollinations selections currently require an active CodeForge subscription. Tatv Smart through the private CodeForge gateway is the signed-in Free chat path. Gemini API is disabled, and guest Smart chat is disabled for the private alpha. Provider API quotas and billing remain separate from CodeForge's implemented server-side plan allowances and action limits.

Inline binary image, audio and video attachments are not enabled for chat in this release because no approved multimodal provider is active. Files that have already been safely converted to extracted text can still be included as text context, subject to the file-analysis quota. Do not assume multimodal support just because a provider's public API supports it.

## Official references

- OpenAI Responses API streaming: https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI models: https://developers.openai.com/api/docs/models
- Anthropic Messages streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- Anthropic models: https://platform.claude.com/docs/en/models/overview
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion/
- DeepSeek errors: https://api-docs.deepseek.com/quick_start/error_codes/
- xAI Grok 4.7 and Responses API: https://docs.x.ai/developers/grok-4-7
- xAI rate limits: https://docs.x.ai/developers/rate-limits


## Official Qwen 3.8 (self-hosted, optional)

The optional **Qwen 3.8 (official)** provider uses the safety-aligned base model `Qwen/Qwen3.8-27B` through an authenticated OpenAI-compatible inference endpoint. The CodeForge server appends `/v1` when needed and calls `/chat/completions`. The model ID is fixed in the current adapter.

Configure these only in the server-side Vercel environment (or a local server environment):

- `QWEN_BASE_URL`: HTTPS origin or base path for your secured inference gateway.
- `QWEN_API_KEY`: credential for the authenticated reverse proxy/inference endpoint.
- `QWEN_ENABLE_TOOLS`: leave `false` (the default). Set to `true` only after your serving stack is configured with the matching Qwen `qwen3_coder` tool-call parser and the complete CodeForge approval path has been validated.

Never expose the key through a `VITE_*` variable, browser storage, or frontend code. Do not expose an unauthenticated inference server to the public internet; put it behind TLS and an authenticated reverse proxy. A local Ollama/MLX server running on a desktop is not reachable from Vercel without a separately designed, secured client-side bridge.

The provider is optional and does not replace Tatv Smart. It is a Plus/Max direct provider, and the inference host's compute charges, availability, concurrency and token limits are separate from CodeForge plan allowances. Model detection only confirms that URL/key settings exist; it does not prove that the host is online or has loaded the model. The first real request is the live access check.

Current limitations: Qwen attachments are not enabled in this adapter; inline image/audio/video requests are blocked until an approved multimodal provider is added. PDF/text-extracted file context remains on the existing extracted-text path. Native Qwen tool calls remain disabled by default. The third-party abliterated/uncensored checkpoint from the reference repository is not supported by this integration.

Official references:
- Qwen model card: https://huggingface.co/Qwen/Qwen3.8-27B
- Qwen serving guide: https://github.com/QwenLM/Qwen3.8
- vLLM OpenAI-compatible server: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
