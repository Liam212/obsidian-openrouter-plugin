import { abortError, type OpenRouterClient } from './api';
import type { Completion, Message, Settings } from './types';

export class Conversation {
  private history: Message[] = [];
  private pending: AbortController | null = null;
  private sensitiveHistory = false;

  constructor(private client: OpenRouterClient) {}

  get busy(): boolean { return this.pending !== null; }
  get requiresSensitiveNotes(): boolean { return this.sensitiveHistory; }

  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.abort(abortError());
  }

  clear(): void {
    this.cancel();
    this.history = [];
    this.sensitiveHistory = false;
  }

  async send(content: string, model: string, settings: Settings, options: { sensitiveNotes?: boolean; onText?: (text: string) => void } = {}): Promise<Completion> {
    if (this.pending) throw new Error('A response is already in progress.');
    const sensitiveNotes = options.sensitiveNotes === true;
    if (this.sensitiveHistory && !sensitiveNotes) throw new Error('Clear chat before turning off Sensitive notes. This conversation contains sensitive messages.');
    const controller = new AbortController();
    this.pending = controller;
    // The request owns an immutable snapshot; later settings or UI changes cannot reroute it.
    const snapshot = { ...settings, cachedModels: [...settings.cachedModels] };
    const user: Message = { role: 'user', content };
    const history = [...this.history, user];
    try {
      const result = await this.client.complete({
        model, settings: snapshot, sensitiveNotes,
        messages: [{ role: 'system', content: snapshot.systemMessage }, ...history],
        signal: controller.signal,
        onText: text => { if (this.pending === controller) options.onText?.(text); }
      });
      if (this.pending !== controller || controller.signal.aborted) throw abortError();
      // Failed/cancelled prompts and partial output never become conversation context.
      this.history = [...history, { role: 'assistant', content: result.content }];
      this.sensitiveHistory ||= sensitiveNotes;
      return result;
    } finally {
      if (this.pending === controller) this.pending = null;
    }
  }
}
