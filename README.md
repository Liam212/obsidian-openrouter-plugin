# OpenRouter Chat for Obsidian

Chat with models available through [OpenRouter](https://openrouter.ai), or generate a response from selected note text. This fork's hardening work is based on AgileAndy's original plugin.

**Requires Obsidian 1.11.4 or newer.** This is a locally built fork; the upstream community listing and upstream releases do not contain these changes.

## Installation

Build this repository using the development instructions below. Copy `main.js`, `manifest.json`, `styles.css`, `LICENSE`, and `THIRD_PARTY_NOTICES.txt` into `<vault>/.obsidian/plugins/openrouter/`, then enable OpenRouter Chat in Community plugins.

The plugin ID remains `openrouter` so existing settings can migrate. This replaces an existing installation of the original plugin; the two cannot run side by side with the same ID. Keep a backup before upgrading. Do not install this fork's files under a different folder name unless you also change the manifest ID.

## Setup

1. Create an API key at [OpenRouter](https://openrouter.ai/keys).
2. In the plugin settings, use **API key** to create or select a named Obsidian secret. The settings file stores the secret's name, not its value.
3. Refresh the model list and explicitly choose a default model. No model is selected automatically on a fresh installation. If a model disappears, choose a replacement; the plugin will not silently choose one for you.
4. Open the chat using the ribbon icon or the **Open chat** command.

On upgrade, an existing plaintext `apiKey` is migrated to Obsidian's secret store and removed from plugin settings after the secret is verified. A conflicting existing secret is preserved. Startup stops on migration failure; the settings file is not rewritten until secret storage succeeds. Earlier backups or synced copies may still contain the old key; rotate it if those copies were exposed.

## Chat and notes

- Press **Enter** to send, or **Shift+Enter** for a new line. IME composition does not send prematurely.
- Search or filter models without silently changing the selected model. A selection hidden by a filter becomes unavailable until you change the filter or explicitly choose another model.
- **Free inference only** uses advertised pricing, including additional listed charges. Unknown prices and dynamic routers are not labelled free; the explicit free router can qualify. Prices are a cached snapshot, not a billing guarantee.
- **Web search** is an explicit opt-in and may incur additional charges. It is blocked while free-only mode is enabled. Web search uses the same setting for chat and selection prompts.
- **Stop** cancels the pending request. **Clear chat** cancels it and discards the conversation history. Failed, cancelled, and partial exchanges are excluded from future request context. Cancellation cannot retract content already sent or guarantee that upstream billing stops immediately.
- Streaming can be enabled in settings. Metrics report elapsed time and API-reported output tokens. First-token timing is shown only for streaming; token counts are not fabricated when absent.
- Copy buttons copy the original Markdown. Basic Markdown formatting, code, tables, and ordinary HTTP(S) links are supported in chat. Raw HTML, remote images, vault embeds, and other plugins' Markdown processors are not executed.
- To work with a note, select text and run **Generate from selection and insert response**. Inspect the plain-text response, then press **Insert** to replace the original selected range. If the note changed or its editor switched files, insertion is refused. You can select and copy the response manually.
- Inserting or pasting the original Markdown into a note lets Obsidian render it normally, including any external images or embeds. Chat's restricted renderer does not change your notes' rendering behavior.

Settings include a system message, streaming, request timeout (default 120 seconds), and maximum output tokens (default 4096). Model-list requests have a 30-second timeout. API/provider limits may be lower.

## Sensitive notes

**Sensitive notes (require ZDR)** is off by default. Turn it on in chat or the selection prompt before sending sensitive text. Each request made with it enabled requires Zero Data Retention model hosts, denies provider data collection, and explicitly disables OpenRouter web search and response caching. It works with streaming and non-streaming responses.

- The switch is local to that chat or prompt. Ordinary requests use your OpenRouter account defaults; switching it off never overrides stricter account privacy rules.
- After a successful sensitive chat exchange, the switch stays on and locks because follow-up requests include that history. Use **Clear chat**, then turn it off for ordinary messages. Failed or cancelled exchanges are not included in later requests. Enabling it later cannot change how earlier requests were handled.
- Selection prompts have no conversation history, so you can switch before each generation. Changing the switch clears the previous response and disables Insert until you generate again.
- The optional **Sensitive notes by default** plugin setting starts new chats and selection prompts with it on. It does not change views already open.
- Sensitive mode temporarily disables the plugin's Web search control, preserving your saved preference. Models with an `:online` search variant are rejected. The selected model and free-only filter remain in effect.
- ZDR can reduce available hosts and increase cost; there is no fixed surcharge. The model picker shows catalog pricing, not a quote for a specific ZDR host. If no compatible endpoint is available, the request fails; the plugin never retries with weaker privacy settings or selects a paid replacement.

This controls model-host routing, not every account service: OpenRouter prompt logging, observability integrations, and account-enforced plugins still require separate configuration. In particular, an enforced web plugin can prevent per-request disabling. Content still goes to OpenRouter and its model hosts. See [Security boundaries](SECURITY.md#sensitive-request-policy) for the exact request policy and limitations.

## Privacy and security

Typed messages, successful conversation history, the system message, and explicitly submitted selected text are sent to OpenRouter and routed to model providers. There is no automatic note indexing, full-vault upload, analytics, chat persistence, or background model-generated action execution. The public model catalog is refreshed on startup when the cache is empty or older than one day; this request does not include an API key. Ordinary links connect externally only when clicked.

The Obsidian secret store keeps keys out of the plugin's `data.json`, but is not a security boundary against other installed plugins or software with access to the device. This plugin does not promise encrypted-at-rest or OS-keychain-backed storage. Provider data retention and billing remain subject to your OpenRouter/provider configuration.

See [SECURITY.md](SECURITY.md) for boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) for validation and the manual Obsidian smoke checklist.

## Development

Use Node.js 24.15 or newer (Node 24 LTS is used by CI):

```sh
npm ci --include=dev --ignore-scripts
npm run check
npm run check:bundle
npm audit --include=dev
```

- `npm run dev`: rebuild the bundle when source changes.
- `npm run typecheck`: strict TypeScript checks for source and tests.
- `npm test`: regression tests, including DOM tests with a mocked Obsidian host and mocked network.
- `npm run build`: typecheck and regenerate the committed `main.js`.
- `npm run check:bundle`: verify that committed `main.js` exactly matches a fresh build.

Edit `src/`, not the generated bundle. The runtime bundle includes the Markdown parser; Obsidian itself remains external. Dependency versions are pinned in `package-lock.json`. The Obsidian API types are pinned to the minimum supported host version. The `moment` override patches a transitive development-only dependency of those types; it does not replace Obsidian's own runtime libraries.

## License

GPL-3.0; see [LICENSE](LICENSE). Original plugin by [AgileAndy](https://github.com/agileandy/obsidian-openrouter-plugin). Bundled third-party license notices are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
