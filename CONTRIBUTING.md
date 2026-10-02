# Development and validation

## Project structure

- `src/main.ts`: plugin lifecycle, serialized settings writes, model refresh, and guarded note insertion.
- `src/settings.ts`: validated settings and credential migration.
- `src/api.ts`: fixed-origin requests, deadlines, cancellation, response validation, and incremental SSE parsing.
- `src/conversation.ts`: committed chat history and cancellation identities.
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
4. With a limited-credit test key, send a streaming and non-streaming message. Exercise invalid key, exhausted credits, and rate limit responses. Check settings for timeout and maximum output tokens.
5. Clear a pending response, send a new prompt, and verify the old answer never appears or joins the new history. Repeat with Stop, view close, plugin disable, and closing the selection modal.
6. Have a model return a Markdown remote image, HTML image, SVG, iframe, vault embed, and executable-plugin code block. Inspect network traffic: no automatic third-party resources should load in chat. Ordinary links should only open when clicked. Check formatting, copying, metrics, pop-out windows, and a narrow mobile layout.
7. Generate a selection response, regenerate with an error, and verify Insert stays disabled. Generate successfully and move the cursor: insertion should target the original range. Edit the note or switch its editor's file while generating: insertion must be refused. Inspect raw Markdown before inserting embeds into a real note.
8. Toggle web search explicitly and verify free-only mode prevents requests that could add search charges. Confirm provider request bodies use the selected model unchanged.

The development work verifies mocked network and DOM behavior. A real host session and authenticated provider behavior must be recorded separately; passing automated tests is not a claim of a complete security audit.
