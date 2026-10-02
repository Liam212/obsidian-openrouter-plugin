import { Modal, type App } from 'obsidian';
import { errorMessage, isAbort, abortError } from './api';
import { button, element, ModelPicker, type PluginHost } from './ui';
import { SensitiveNotesControl } from './sensitive-notes';

export class PromptModal extends Modal {
  private picker!: ModelPicker;
  private result: string | null = null;
  private request: AbortController | null = null;
  private response!: HTMLElement;
  private insertButton!: HTMLButtonElement;
  private generateButton!: HTMLButtonElement;
  private sensitiveNotes!: SensitiveNotesControl;
  private closed = false;

  constructor(app: App, private host: PluginHost, private prompt: string, private onInsert: (text: string) => void, private onDispose: () => void = () => undefined) {
    super(app);
  }

  onOpen(): void {
    this.closed = false;
    this.contentEl.classList.add('openrouter-modal');
    element(this.contentEl, 'h2', '', 'OpenRouter prompt');
    this.picker = new ModelPicker(this.contentEl, this.host);
    this.sensitiveNotes = new SensitiveNotesControl(this.contentEl, this.host.settings.sensitiveNotesByDefault, () => {
      this.result = null;
      this.insertButton.disabled = true;
      this.response.textContent = 'Privacy mode changed. Generate a new response.';
    });
    element(this.contentEl, 'p', 'openrouter-privacy-hint', 'Generate sends the selected text to OpenRouter and the selected model’s providers. Insert replaces the original selection with raw Markdown; Obsidian may render its embeds in the note.');
    element(this.contentEl, 'h3', '', 'Selected text');
    element(this.contentEl, 'div', 'openrouter-modal-prompt', this.prompt);
    element(this.contentEl, 'h3', '', 'Response');
    this.response = element(this.contentEl, 'div', 'openrouter-modal-response', 'Response will appear here…');
    const actions = element(this.contentEl, 'div', 'openrouter-modal-buttons');
    this.generateButton = button(actions, 'Generate', 'openrouter-modal-generate', () => { void this.generate(); });
    this.insertButton = button(actions, 'Insert', 'openrouter-modal-insert', () => {
      if (this.closed || this.request || this.result === null) return;
      try { this.onInsert(this.result); this.close(); }
      catch (error) { this.response.textContent = errorMessage(error); }
    });
    this.insertButton.disabled = true;
    button(actions, 'Cancel', 'openrouter-modal-cancel', () => this.close());
  }

  async generate(): Promise<void> {
    if (this.request || this.closed) return;
    this.result = null;
    this.insertButton.disabled = true;
    const request = new AbortController();
    this.request = request;
    this.generateButton.disabled = true;
    this.picker.setDisabled(true);
    this.sensitiveNotes.setState(true);
    this.response.textContent = 'Thinking…';
    try {
      const settings = { ...this.host.settings, cachedModels: [...this.host.settings.cachedModels] };
      const result = await this.host.client.complete({
        model: this.picker.value, settings, sensitiveNotes: this.sensitiveNotes.enabled,
        messages: [{ role: 'system', content: settings.systemMessage }, { role: 'user', content: this.prompt }],
        signal: request.signal,
        onText: text => { if (this.request === request && !this.closed) this.response.textContent = text; }
      });
      if (this.request !== request || request.signal.aborted || this.closed) return;
      this.result = result.content;
      this.response.textContent = result.content;
      this.insertButton.disabled = false;
    } catch (error) {
      if (this.request === request && !this.closed) this.response.textContent = isAbort(error) ? 'Cancelled.' : errorMessage(error);
    } finally {
      if (this.request === request) {
        this.request = null;
        if (!this.closed) {
          this.generateButton.disabled = false;
          this.picker.setDisabled(false);
          this.sensitiveNotes.setState(false);
        }
      }
    }
  }

  onClose(): void {
    this.closed = true;
    const request = this.request;
    this.request = null;
    request?.abort(abortError());
    this.result = null;
    this.picker?.destroy();
    this.contentEl.replaceChildren();
    this.onDispose();
  }
}
