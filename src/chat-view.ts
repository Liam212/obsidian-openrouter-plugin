import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import { errorMessage, isAbort } from './api';
import { Conversation } from './conversation';
import { renderMessage } from './render';
import { button, element, ModelPicker, type PluginHost } from './ui';
import type { Completion } from './types';
import { SensitiveNotesControl } from './sensitive-notes';

export const VIEW_TYPE = 'openrouter-chat-view';

export class ChatView extends ItemView {
  private conversation: Conversation;
  private picker!: ModelPicker;
  private textarea!: HTMLTextAreaElement;
  private messages!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private sensitiveNotes!: SensitiveNotesControl;
  private webSearch!: HTMLInputElement;
  private epoch = 0;
  private closed = false;
  private activeResponse: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private host: PluginHost) {
    super(leaf);
    this.conversation = new Conversation(host.client);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'OpenRouter Chat'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.replaceChildren();
    this.contentEl.classList.add('openrouter-chat-container');
    const header = element(this.contentEl, 'div', 'openrouter-chat-header');
    element(header, 'h3', '', 'OpenRouter Chat');
    this.picker = new ModelPicker(header, this.host);
    this.sensitiveNotes = new SensitiveNotesControl(header, this.host.settings.sensitiveNotesByDefault, () => this.updatePrivacyControls());
    const searchLabel = element(header, 'label', 'openrouter-websearch-label');
    const webSearch = element(searchLabel, 'input');
    this.webSearch = webSearch;
    webSearch.type = 'checkbox';
    webSearch.checked = this.host.settings.useWebSearch;
    searchLabel.append('Web search (additional charges may apply)');
    webSearch.addEventListener('change', () => {
      if (this.sensitiveNotes.enabled || this.conversation.busy) {
        this.updatePrivacyControls();
        return;
      }
      if (webSearch.checked && this.host.settings.showFreeModelsOnly) {
        webSearch.checked = false;
        new Notice('Turn off free-only mode before enabling paid web search.');
        return;
      }
      this.host.settings.useWebSearch = webSearch.checked;
      void this.host.saveSettings();
    });
    element(header, 'p', 'openrouter-privacy-hint', 'Messages go to OpenRouter and the selected model’s providers. Images and vault embeds are blocked in chat.');
    this.messages = element(this.contentEl, 'div', 'openrouter-messages-container');
    this.messages.setAttribute('aria-label', 'Conversation');
    const input = element(this.contentEl, 'div', 'openrouter-input-container');
    this.textarea = element(input, 'textarea', 'openrouter-input');
    this.textarea.placeholder = 'Type your message…';
    this.textarea.setAttribute('aria-label', 'Message');
    this.textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    const actions = element(input, 'div', 'openrouter-chat-actions');
    this.sendButton = button(actions, 'Send', 'openrouter-send-button', () => { void this.send(); });
    this.stopButton = button(actions, 'Stop', 'openrouter-stop-button', () => this.stop());
    button(actions, 'Clear chat', 'openrouter-clear-button', () => this.clear());
    this.setBusy(false);
  }

  private setBusy(busy: boolean): void {
    this.sendButton.disabled = busy;
    this.stopButton.disabled = !busy;
    this.picker.setDisabled(busy);
    this.updatePrivacyControls(busy);
    this.messages.setAttribute('aria-busy', String(busy));
  }

  private updatePrivacyControls(busy = this.conversation.busy): void {
    this.sensitiveNotes.setState(busy, this.conversation.requiresSensitiveNotes);
    this.webSearch.disabled = busy || this.sensitiveNotes.enabled;
    this.webSearch.checked = this.host.settings.useWebSearch && !this.sensitiveNotes.enabled;
  }

  private message(role: string): { message: HTMLElement; content: HTMLElement } {
    const message = element(this.messages, 'div', `openrouter-message openrouter-message-${role.toLowerCase()}`);
    element(message, 'div', 'openrouter-message-role', role);
    const content = element(message, 'div', 'openrouter-message-content');
    return { message, content };
  }

  private scroll(): void { this.messages.scrollTop = this.messages.scrollHeight; }

  private stop(): void {
    this.epoch++;
    this.conversation.cancel();
    if (this.activeResponse) this.activeResponse.textContent = 'Cancelled. This exchange was not added to the conversation context.';
    this.activeResponse = null;
    this.setBusy(false);
  }

  clear(): void {
    this.epoch++;
    this.conversation.clear();
    this.activeResponse = null;
    this.messages.replaceChildren();
    this.setBusy(false);
  }

  async send(): Promise<void> {
    const content = this.textarea.value.trim();
    if (!content || this.conversation.busy || this.closed) return;
    if (!this.picker.value) { new Notice('Choose an available model first.'); return; }
    const epoch = ++this.epoch;
    const model = this.picker.value;
    const sensitiveNotes = this.sensitiveNotes.enabled;
    this.textarea.value = '';
    renderMessage(content, this.message('User').content);
    const answer = this.message('Assistant');
    answer.content.textContent = 'Thinking…';
    this.activeResponse = answer.content;
    this.setBusy(true);
    try {
      const result = await this.conversation.send(content, model, this.host.settings, {
        sensitiveNotes,
        onText: text => {
          if (this.epoch !== epoch || this.closed) return;
          answer.content.textContent = text;
          this.scroll();
        }
      });
      if (this.epoch !== epoch || this.closed) return;
      renderMessage(result.content, answer.content);
      this.addActions(answer.message, result, model, sensitiveNotes);
    } catch (error) {
      if (this.epoch !== epoch || this.closed) return;
      answer.content.textContent = isAbort(error) ? 'Cancelled.' : `${errorMessage(error)} This exchange was not added to the conversation context.`;
      if (!this.textarea.value) this.textarea.value = content;
    } finally {
      if (this.epoch === epoch && !this.closed) {
        this.activeResponse = null;
        this.setBusy(false);
        this.scroll();
      }
    }
  }

  private addActions(parent: HTMLElement, result: Completion, model: string, sensitiveNotes: boolean): void {
    const copy = button(parent, 'Copy', 'openrouter-copy-button', () => {
      void (async () => {
        try {
          await parent.ownerDocument.defaultView!.navigator.clipboard.writeText(result.content);
          copy.textContent = 'Copied';
        } catch { new Notice('Could not copy the response.'); }
      })();
    });
    const details = element(parent, 'details', 'openrouter-response-metrics');
    element(details, 'summary', '', 'Response metrics');
    const text = [`Model: ${model}`, `Privacy: ${sensitiveNotes ? 'Sensitive notes — ZDR required' : 'Account defaults'}`, `Total time: ${result.totalMs} ms`,
      result.firstTokenMs === null ? 'First token: unavailable for non-streaming responses' : `First token: ${result.firstTokenMs} ms`,
      result.completionTokens === null ? 'Token count: not reported' : `Output tokens: ${result.completionTokens}`];
    element(details, 'div', '', text.join('\n'));
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.epoch++;
    this.conversation.clear();
    this.picker?.destroy();
    this.activeResponse = null;
    this.contentEl.replaceChildren();
  }
}
