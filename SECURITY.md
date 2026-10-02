# Security boundaries

This document describes intended protections, not a guarantee that this plugin or its host is vulnerability-free.

## Data and credentials

- Requests are limited in code to HTTPS endpoints under `https://openrouter.ai/api/v1/`. Redirects are rejected and browser credentials are omitted.
- Chat requests use the named Obsidian secret as the bearer credential. Public catalog requests do not send credentials.
- Only explicitly submitted chat/selected text and the current conversation context are sent. Successful exchanges are retained in memory until the view closes or chat is cleared.
- No provider error bodies, keys, prompts, or generated answers are written to logs. Error notices use local messages and HTTP status codes.
- Secrets migrate out of legacy settings only after storage succeeds and the secret can be read back. Settings writes use a whitelist and an ordered queue.
- Obsidian SecretStorage is not plugin isolation, and this project makes no encryption-at-rest claim. Previous backups and external copies of `data.json` are outside migration's reach.

## Untrusted output

Chat uses a Markdown token parser and an allowlist of DOM elements. It does not use `innerHTML`, Obsidian's MarkdownRenderer, external images/media, inline CSS, raw HTML, executable code blocks, or plugin postprocessors. Only explicit HTTP(S) links without embedded credentials become clickable. Links suppress referrer and opener access. Streaming output is plain text until completion.

The selection modal previews raw text. Clicking Insert or copying/pasting the Markdown into a note deliberately leaves this boundary: Obsidian's normal note renderer and other installed plugins may process that content. Review it first.

Model output never invokes tools, reads other notes, executes commands, or writes files automatically. Insertion requires a click, a completed current response, and an unchanged original note/file identity.

## Requests and cost

Every request has an AbortController and an overall deadline covering headers and body consumption. Clear, Stop, modal close, view close, and plugin unload cancel applicable work. Generation identity checks reject stale completions even if cancellation is ignored by a transport.

Model selection is explicit; missing/filtered models cannot fall through to the first option. Free inference labels require known zero pricing, excluding dynamic routers except the explicit free router. Web search is blocked in free-only mode. Advertised pricing can change, and cancellation does not guarantee upstream work or charges stop immediately. Configure an appropriate key credit limit with your provider.

Responses and SSE events are size-limited, malformed/truncated streams are rejected, and failed or partial exchanges are not retained as conversation context. Output token limits bound requested response length; provider context/rate limits still apply.

## Dependency controls

The lockfile and exact direct versions make installs repeatable. CI runs TypeScript checks, regression tests, deterministic-bundle verification, and an audit of runtime and development dependencies. CI actions are pinned to commits and the workflow has read-only repository permissions. Dependabot checks npm and action updates.

## Reporting

Report reproducible security problems privately to the maintainer of the fork you use, using its private security-reporting channel if available. Do not include real keys, private notes, or exploit payloads containing someone else's data in public issues. This local fork has not established a separate hosted reporting channel.
