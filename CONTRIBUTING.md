# Development and validation

## Project structure

- `src/main.ts`: plugin lifecycle, serialized settings writes, model refresh, and guarded note insertion.
- `src/settings.ts`: validated settings and credential migration.
- `src/api.ts`: fixed-origin requests, deadlines, cancellation, response validation, and incremental SSE parsing.
- `src/mobile-transport.ts`: allowlisted native mobile HTTP adapter; buffered replies, with cancellation/deadlines enforced by the caller rather than the host transport.
- `src/conversation.ts`: committed chat history and cancellation identities.
- `src/sensitive-notes.ts`: local privacy controls and protected-history state.
- `src/models.ts` / `src/ui.ts`: pricing validation and explicit model selection.
- `src/render.ts`: restricted Markdown-to-DOM rendering.
- `src/chat-view.ts`, `src/prompt-modal.ts`, `src/settings-tab.ts`: Obsidian UI.
- `tests/`: regression tests using jsdom and a deliberately small mocked Obsidian API. No test uses a real API key or calls a paid model.

Use `npm ci --include=dev --ignore-scripts`, then `npm run check`, `npm run check:bundle`, and `npm audit --include=dev`. Include updated `main.js` with source changes. Keep package, manifest and versions.json versions consistent. When changing bundled dependencies, run `node scripts/licenses.mjs` and include updated notices.

Do not add Obsidian MarkdownRenderer or HTML insertion to the chat renderer. A sanitizer applied after creating live resource elements is too late to prevent automatic network requests. New output capabilities need an explicit boundary and regression tests.

## Manual Obsidian smoke checklist

Automated host mocks and ordinary-browser checks do not establish compatibility with the full desktop/mobile host. Run these checks in a disposable vault before a release, on Obsidian 1.11.4 (the declared minimum) and the current desktop/mobile versions:

1. Install the five documented distribution files. Enable, disable, and reload the plugin. Confirm chat opens even while offline and a failed catalog refresh preserves the last successful cache.
2. Upgrade a disposable legacy settings file with a test credential. Verify it migrates to a named secret and `data.json` no longer contains the literal key. Verify another existing secret is not overwritten. Verify storage failures are actionable and do not delete the original configuration.
3. Select a valid model; refresh and search the list. Confirm the choice is preserved when available and no paid replacement is chosen when it disappears. Verify a new installation requires an explicit selection.
4. With a limited-credit test key, send streaming and non-streaming messages on desktop. On mobile, confirm the native request path loads the public catalog and completes chat and selection prompts without browser fetch, sends `stream: false` even when the saved desktop preference is on, and shows the Responses on mobile explanation. Exercise invalid key, exhausted credits, and rate limit responses. Check timeout and maximum output tokens. Native mobile cancellation must immediately discard output; the underlying host request may continue.
5. Clear a pending response, send a new prompt, and verify the old answer never appears or joins the new history. Repeat with Stop, view close, plugin disable, and closing the selection modal.
6. Have a model return a Markdown remote image, HTML image, SVG, iframe, vault embed, and executable-plugin code block. Inspect network traffic: no automatic third-party resources should load in chat. Ordinary links should only open when clicked. Check formatting, copying, metrics, pop-out windows, and a narrow mobile layout.
7. Generate a selection response, regenerate with an error, and verify Insert stays disabled. Generate successfully and move the cursor: insertion should target the original range. Edit the note or switch its editor's file while generating: insertion must be refused. Inspect raw Markdown before inserting embeds into a real note.
8. Toggle web search explicitly and verify free-only mode prevents requests that could add search charges. Confirm provider request bodies use the selected model unchanged.
9. Enable Sensitive notes separately in chat and a selection prompt. With streaming on and off, inspect outgoing requests for `provider.zdr: true`, `provider.data_collection: "deny"`, the disabled web plugin, and `X-OpenRouter-Cache: false`. Confirm search is unavailable while sensitive mode is on and its saved preference returns when it is off. Test an unavailable ZDR model: there must be no retry with weaker constraints or paid replacement. Verify the account has no enforced web plugin or content-logging integration that conflicts with the intended policy.
10. After a successful sensitive chat request, verify follow-ups stay protected and the switch cannot be turned off until Clear chat. Clear during a pending request and confirm a late response cannot restore its history. In the selection modal, switching privacy mode after generation must disable Insert. Toggle Sensitive notes by default, reopen a chat/prompt, and reload the plugin to check persistence; already-open views must retain their own choice.

The development work verifies mocked network and DOM behavior. A real host session and authenticated provider behavior must be recorded separately; passing automated tests is not a claim of a complete security audit.
