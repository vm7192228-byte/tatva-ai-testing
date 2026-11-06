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

## Dhwani Smart routing and failover

Dhwani Smart uses the same server-side routing order for the owner, signed-in users and guests:

1. **First — shared FreeLLMAPI:** configure `FREELLMAPI_BASE_URL`, `FREELLMAPI_API_KEY` and optionally `FREELLMAPI_MODEL`. The unified key stays server-side and is never exposed to the browser or forwarded to a private gateway.
2. **Second — authenticated private CodeForge gateways:** configure `CODEFORGE_GATEWAY_URL` and up to three independent fallback URLs. This tier is available only when the request has a verified signed-in user's Supabase access JWT. The Workbench forwards only that user's JWT; it does not forward a gateway administrator token or the FreeLLMAPI key. Guest traffic skips this tier.
3. **Last — configured direct-provider fallbacks:** after the eligible private gateways, Smart can try configured server-side OpenAI, Anthropic, DeepSeek, xAI, Qwen, Cloudflare Workers AI and Pollinations providers. Guests can use this tier when the corresponding server-side provider configuration is available.

FreeLLMAPI, private gateways and direct providers are upstream infrastructure. Any upstream credential, model, billing, quota, rate-limit, timeout or service failure before answer text is sent can move the request to the next eligible route. User authentication/access denials, bans or suspension, user-level quota and permission decisions, and provider content-policy blocks remain terminal and are never bypassed. A request is not replayed after answer text, a tool execution or an approval side effect starts. Provider diagnostics and credentials are not exposed in user-facing errors.

The Workbench continues to enforce its own account access and feature reservations. Text chat routing does not bypass image, video or file-analysis plan quotas. Each private gateway also independently validates the JWT, derives the user ID from the verified subject, and enforces its own user/provider budgets.

**Gemini API remains disabled in this learner-facing release.** The current Gemini API Additional Terms (effective March 23, 2026) require the API operator to be 18+ and prohibit API Clients that are directed toward or likely to be accessed by under-18s. Do not enable Gemini directly, through the public gateway's model pool, or through a private gateway for this learner-facing service. Do not submit private or sensitive content to any unpaid provider service. Reassess only if the product's audience and operator eligibility genuinely meet the current provider terms.

For the FreeLLMAPI first hop, verify that the endpoint operator and each upstream provider's terms authorize the intended shared, multi-user application traffic. An open-source code license alone does not grant permission to pool upstream free quotas or override provider terms. If an endpoint is explicitly documented as single-user or personal-experimentation only, do not use it as a shared production entitlement; use an authorized multi-user endpoint or separately configured provider credentials.

Each private CodeForge gateway must independently trust the Workbench Supabase Auth issuer/JWKS, expose the OpenAI-compatible chat route, and have an enabled chat model plus valid provider credentials. Keep `ADMIN_ACCESS_TOKEN`, database passwords, provider keys and service-role keys inside the gateway's own server-side secret store. Do not put them in Workbench browser code or the user's Bearer token.

The private gateway's PostgreSQL catalog is administered separately from the Workbench database. Add approved upstream credentials through the gateway's admin dashboard, sync/import the provider's models, review capability/pricing/limits, and explicitly enable suitable models. A healthy `/healthz` endpoint does not prove that an inference request succeeds.

Before inviting testers, verify a real FreeLLMAPI first-hop request, confirm an independently deployed private gateway accepts a valid signed-in user's JWT, verify that guest traffic skips the private-only tier, and check that configured direct-provider fallbacks work. Confirm that all credentials remain server-side and that user-level access/quota/content-policy denials remain terminal.

**Do not add advertised free-token totals from separate providers as a guaranteed pooled business quota.** Provider account limits, commercial permissions, model availability, rate limits and pricing remain controlled by each upstream provider. Multi-tier routing improves availability; it does not create free inference capacity.

## Provider billing versus CodeForge plans

A detected API key means only that a server-side credential is present. It does not prove the provider account is active, has model access, has remaining balance, or will accept the selected model. The first real request is the actual access check.

ChatGPT Free/Plus/Pro subscriptions and the OpenAI API platform use separate billing systems. Claude Free/Pro subscriptions and the Anthropic API Console are also separate products. A consumer chat subscription does not automatically provide API usage for CodeForge. Check the linked provider account's API billing and model pricing before enabling a provider. DeepSeek usage is token-priced and its currently documented model catalog should be checked before changing the model ID.

CodeForge's own chat allowances are separate from provider billing:
- Free: signed-in accounts can use Dhwani Smart through the private CodeForge gateway, subject to Workbench request limits and the gateway's per-user token/request budgets. Guest Smart chat is disabled for the private alpha until a separate anonymous identity and per-guest quota design is implemented. Gemini API is disabled for this release.
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

The Workbench chat limiter is 6 requests per minute for guests and 15 per minute for signed-in accounts. For this private alpha, Dhwani Smart is available to owner, signed-in and guest requests. Every request starts at FreeLLMAPI; signed-in requests may then use the JWT-protected private gateways, while guest requests skip that authenticated-only tier and can continue to configured direct providers. Gemini API is disabled in this release, and the configured FreeLLMAPI endpoint is the first Smart hop, subject to its operator and upstream provider terms. Full-length video generation is also disabled; do not show or consume legacy 5–8 second credits.

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

Direct OpenAI, Claude, DeepSeek, Grok, Cloudflare and Pollinations selections currently require an active CodeForge subscription. Dhwani Smart uses the universal FreeLLMAPI-first routing chain; authenticated private gateways are an additional tier for signed-in users. Gemini API is disabled, and guest Smart chat is disabled for the private alpha. Provider API quotas and billing remain separate from CodeForge's implemented server-side plan allowances and action limits.

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

The provider is optional and does not replace Dhwani Smart. It is a Plus/Max direct provider, and the inference host's compute charges, availability, concurrency and token limits are separate from CodeForge plan allowances. Model detection only confirms that URL/key settings exist; it does not prove that the host is online or has loaded the model. The first real request is the live access check.

Current limitations: Qwen attachments are not enabled in this adapter; inline image/audio/video requests are blocked until an approved multimodal provider is added. PDF/text-extracted file context remains on the existing extracted-text path. Native Qwen tool calls remain disabled by default. The third-party abliterated/uncensored checkpoint from the reference repository is not supported by this integration.

Official references:
- Qwen model card: https://huggingface.co/Qwen/Qwen3.8-27B
- Qwen serving guide: https://github.com/QwenLM/Qwen3.8
- vLLM OpenAI-compatible server: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
