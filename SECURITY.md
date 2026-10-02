# Security boundaries

This document describes intended protections, not a guarantee that this plugin or its host is vulnerability-free.

## Data and credentials

- Requests start only at the fixed HTTPS model-catalog and chat-completion endpoints under `https://openrouter.ai/api/v1/`. Desktop fetch rejects redirects and omits browser credentials. Mobile uses Obsidian's native `requestUrl`; its public API does not expose redirect or cookie controls, so those behaviors are delegated to the host and are not enforced by this plugin.
- Chat requests use the named Obsidian secret as the bearer credential. Public catalog requests never include a plugin-supplied API key, body, or authorization header.
- Only explicitly submitted chat/selected text and the current conversation context are sent. Successful exchanges are retained in memory until the view closes or chat is cleared.
- No provider error bodies, keys, prompts, or generated answers are written to logs. Error notices use local messages and HTTP status codes.
- Secrets migrate out of legacy settings only after storage succeeds and the secret can be read back. Settings writes use a whitelist and an ordered queue.
- Obsidian SecretStorage is not plugin isolation, and this project makes no encryption-at-rest claim. Previous backups and external copies of `data.json` are outside migration's reach.

## Sensitive request policy

Sensitive notes is an explicit per-request choice, initially off. The saved `sensitiveNotesByDefault` boolean only initializes new chat/prompt controls. Both streaming and non-streaming requests with the switch enabled send:

```json
{
  "provider": { "zdr": true, "data_collection": "deny" },
  "plugins": [{ "id": "web", "enabled": false }]
}
```

They also send the `X-OpenRouter-Cache: false` header. This follows OpenRouter's [ZDR routing](https://openrouter.ai/docs/guides/features/zdr), [provider data-collection filters](https://openrouter.ai/docs/guides/routing/provider-selection), [plugin overrides](https://openrouter.ai/docs/guides/features/plugins/overview), and [response-cache controls](https://openrouter.ai/docs/guides/features/response-caching). Per-request ZDR alone does not disable OpenRouter response caching, so the explicit header is required. Provider in-memory prompt caching may still be allowed under OpenRouter's ZDR definition; this setting does not promise no transient processing or storage.

Normal requests omit these provider and cache overrides rather than sending `zdr: false` or allowing collection. Neither mode weakens account-level ZDR restrictions. The selected model is unchanged, web-search model variants are rejected in sensitive mode, and the plugin never retries failed sensitive requests with relaxed restrictions. OpenRouter may route between endpoints that meet the requested constraints; this is gateway enforcement based on provider policies, not independent verification by the plugin.

Successful sensitive exchanges mark in-memory chat history as requiring sensitive routing. UI controls cannot be downgraded while sending or while that history remains, and the conversation layer independently rejects ordinary sends with sensitive history. Only clearing the conversation removes that restriction. Cancelled/failed exchanges are excluded from history, and late completions cannot restore cleared history. The selection modal has no follow-up history and invalidates an insertable result if its privacy choice changes.

ZDR is a model-endpoint policy, not a complete account or device privacy boundary. Account prompt logging, observability exports, and third-party tools/plugins have their own policies. OpenRouter's **Prevent overrides** plugin setting can force web search despite a request-level disable; configure the account accordingly before using sensitive text. This plugin does not inspect those account settings. Operational/billing metadata, local vault files, clipboard contents, other Obsidian plugins, and content already sent before enabling the switch are outside this request policy.

## Untrusted output

Chat uses a Markdown token parser and an allowlist of DOM elements. It does not use `innerHTML`, Obsidian's MarkdownRenderer, external images/media, inline CSS, raw HTML, executable code blocks, or plugin postprocessors. Only explicit HTTP(S) links without embedded credentials become clickable. Links suppress referrer and opener access. Streaming output is plain text until completion.

The selection modal previews raw text. Clicking Insert or copying/pasting the Markdown into a note deliberately leaves this boundary: Obsidian's normal note renderer and other installed plugins may process that content. Review it first.

Model output never invokes tools, reads other notes, executes commands, or writes files automatically. Insertion requires a click, a completed current response, and an unchanged original note/file identity.

## Requests and cost

Every request has an AbortController and an overall deadline. Clear, Stop, modal close, view close, and plugin unload cancel applicable plugin work. Desktop fetch receives the abort signal. Mobile native requests cannot be aborted at the transport level: the plugin stops waiting immediately and rejects late results, while the host request may continue transferring data and incurring charges. Generation identity checks prevent discarded output from appearing or becoming conversation history.

Mobile selects the native transport before sending, requests non-streaming responses, and retains the same model, message, output-limit, and Sensitive notes policy. There is no automatic retry through a second transport after a failure, avoiding duplicate submissions. Desktop streaming remains supported.

Model selection is explicit; missing/filtered models cannot fall through to the first option. Free inference labels require known zero pricing, excluding dynamic routers except the explicit free router. Web search is blocked in free-only mode. Advertised pricing can change, and cancellation does not guarantee upstream work or charges stop immediately. Configure an appropriate key credit limit with your provider.

Responses and SSE events are size-limited before parsing, malformed/truncated streams are rejected, and failed or partial exchanges are not retained as conversation context. On mobile, the host buffers the full HTTP response before returning it, so the plugin's size check cannot bound the native download or its buffering allocation. Output token limits bound requested response length; provider context/rate limits still apply.

## Dependency controls

The lockfile and exact direct versions make installs repeatable. CI runs TypeScript checks, regression tests, deterministic-bundle verification, and an audit of runtime and development dependencies. CI actions are pinned to commits and the workflow has read-only repository permissions. Dependabot checks npm and action updates.

## Reporting

Report reproducible security problems privately to the maintainer of the fork you use, using its private security-reporting channel if available. Do not include real keys, private notes, or exploit payloads containing someone else's data in public issues. This local fork has not established a separate hosted reporting channel.
