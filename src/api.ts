import { parseModels } from './models';
import { reportedCost } from './cost';
import { isRecord, type Completion, type Message, type Model, type Settings } from './types';

const API = 'https://openrouter.ai/api/v1/';
const MAX_ANSWER = 1_000_000;
const MAX_EVENT = 256_000;

export function abortError(): DOMException {
  return new DOMException('Request cancelled.', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}

function usageTokens(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const tokens = value.completion_tokens;
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
}

async function readText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('OpenRouter returned an empty response.');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('OpenRouter response exceeded the size limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const text = await readText(response, limit, signal);
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('OpenRouter returned invalid JSON.'); }
}

/** Incremental SSE framing, including split UTF-8, CRLF, comments and multi-line data. */
export async function readCompletionStream(response: Response, signal: AbortSignal, onText: (text: string) => void): Promise<Pick<Completion, 'content' | 'completionTokens' | 'firstTokenMs' | 'costUsd'>> {
  if (!response.body) throw new Error('OpenRouter returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  let buffer = '';
  let eventData: string[] = [];
  let eventSize = 0;
  let content = '';
  let completionTokens: number | null = null;
  let costUsd: number | null = null;
  let firstTokenMs: number | null = null;
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  function dispatch() {
    if (!eventData.length) return;
    const data = eventData.join('\n');
    eventData = [];
    eventSize = 0;
    if (data.trim() === '[DONE]') { finished = true; return; }
    let event: unknown;
    try { event = JSON.parse(data) as unknown; }
    catch { throw new Error('OpenRouter returned a malformed streaming event.'); }
    if (!isRecord(event)) throw new Error('OpenRouter returned an invalid streaming event.');
    if (event.error) throw new Error('OpenRouter reported a streaming error. Please retry.');
    completionTokens = usageTokens(event.usage) ?? completionTokens;
    // Usage events contain cumulative totals, not increments. Zero is a valid charge.
    costUsd = reportedCost(event.usage) ?? costUsd;
    const choice: unknown = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (!isRecord(choice)) return; // Usage-only events may have no choices.
    if (choice.finish_reason === 'error') throw new Error('OpenRouter interrupted the response. Please retry.');
    const delta = isRecord(choice.delta) ? choice.delta.content : undefined;
    if (delta === undefined || delta === null || delta === '') return;
    if (typeof delta !== 'string') throw new Error('OpenRouter returned unsupported response content.');
    firstTokenMs ??= Date.now() - started;
    content += delta;
    if (content.length > MAX_ANSWER) throw new Error('OpenRouter response exceeded the size limit.');
    onText(content);
  }
  function line(value: string) {
    if (value === '') { dispatch(); return; }
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).replace(/^ /, '');
    eventSize += data.length + 1;
    if (eventSize > MAX_EVENT) throw new Error('OpenRouter streaming event exceeded the size limit.');
    eventData.push(data);
  }
  function consume(eof: boolean) {
    while (!finished) {
      const index = buffer.search(/[\r\n]/);
      if (index === -1) break;
      if (!eof && buffer[index] === '\r' && index === buffer.length - 1) break;
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      const value = buffer.slice(0, index);
      buffer = buffer.slice(index + width);
      line(value);
    }
    if (buffer.length > MAX_EVENT) throw new Error('OpenRouter streaming line exceeded the size limit.');
    if (eof && !finished) {
      if (buffer) line(buffer);
      dispatch();
    }
  }
  try {
    while (!finished) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      consume(done);
      if (done) break;
    }
    if (!finished) throw new Error('The response stream ended before completion. Please retry.');
    if (!content.trim()) throw new Error('OpenRouter returned no text. Try another model.');
    return { content, completionTokens, firstTokenMs, costUsd };
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface CompletionRequest {
  model: string;
  messages: Message[];
  settings: Settings;
  sensitiveNotes?: boolean;
  signal?: AbortSignal;
  onText?: (content: string) => void;
}

export class OpenRouterClient {
  private requests = new Set<AbortController>();
  private disposed = false;

  constructor(private getKey: () => string | null, private fetcher: typeof fetch = fetch, readonly supportsStreaming = true) {}

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) request.abort(abortError());
    this.requests.clear();
  }

  private async request<T>(path: 'models' | 'chat/completions', init: RequestInit, timeoutMs: number, signal: AbortSignal | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw abortError();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason ?? abortError());
    const timer = setTimeout(() => controller.abort(new Error('OpenRouter request timed out. Please retry.')), timeoutMs);
    this.requests.add(controller);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? abortError());
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      controller.signal.throwIfAborted();
      const work = (async () => {
        let response: Response;
        try {
          response = await this.fetcher(API + path, {
            ...init, signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'
          });
        } catch {
          controller.signal.throwIfAborted();
          throw new Error('Could not connect to OpenRouter. Check your connection and retry.');
        }
        controller.signal.throwIfAborted();
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const messages: Record<number, string> = {
            401: 'OpenRouter rejected the API key. Check the selected secret.',
            402: 'OpenRouter credits are insufficient.',
            429: 'OpenRouter rate limit reached. Try again later.'
          };
          // Do not display/log provider bodies, which may echo keys or prompt content.
          throw new Error(messages[response.status] ?? `OpenRouter request failed (HTTP ${response.status}).`);
        }
        return consume(response, controller.signal);
      })();
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      controller.signal.removeEventListener('abort', rejectAbort);
      this.requests.delete(controller);
    }
  }

  async models(signal?: AbortSignal): Promise<Model[]> {
    return this.request('models', { method: 'GET' }, 30_000, signal,
      async (response, requestSignal) => parseModels(await readJson(response, 16_000_000, requestSignal)));
  }

  async complete(options: CompletionRequest): Promise<Completion> {
    const { model, settings, messages, signal, onText } = options;
    const sensitiveNotes = options.sensitiveNotes === true;
    const useWebSearch = settings.useWebSearch && !sensitiveNotes;
    const useStreaming = settings.useStreaming && this.supportsStreaming;
    const selected = settings.cachedModels.find(candidate => candidate.id === model);
    if (!model || !selected) throw new Error('Choose an available model before sending. Refresh the model list if needed.');
    if (sensitiveNotes && model.split(':').includes('online')) throw new Error('Choose a model without the :online web-search variant for Sensitive notes.');
    if (settings.showFreeModelsOnly && !selected.isFree) throw new Error('Choose a model with verified free inference, or turn off the free-only filter.');
    if (settings.showFreeModelsOnly && useWebSearch) throw new Error('Web search may cost money. Turn off free-only mode before enabling it.');
    const key = this.getKey()?.trim();
    if (!key) throw new Error('Select an OpenRouter API key in the plugin settings.');
    const started = Date.now();
    return this.request('chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://obsidian.md', 'X-Title': 'Obsidian OpenRouter Chat',
        ...(sensitiveNotes ? { 'X-OpenRouter-Cache': 'false' } : {})
      },
      body: JSON.stringify({
        model, messages, stream: useStreaming, max_tokens: settings.maxOutputTokens,
        ...(sensitiveNotes ? {
          provider: { zdr: true, data_collection: 'deny' },
          // Explicitly override an account's web-search default, not just the local toggle.
          plugins: [{ id: 'web', enabled: false }]
        } : useWebSearch ? { plugins: [{ id: 'web' }] } : {})
      })
    }, settings.requestTimeoutSeconds * 1000, signal, async (response, requestSignal) => {
      if (useStreaming) {
        const headersMs = Date.now() - started;
        const result = await readCompletionStream(response, requestSignal, text => {
          requestSignal.throwIfAborted();
          onText?.(text);
        });
        return { ...result, totalMs: Date.now() - started, firstTokenMs: result.firstTokenMs === null ? null : headersMs + result.firstTokenMs };
      }
      const data = await readJson(response, 4_000_000, requestSignal);
      if (!isRecord(data) || data.error) throw new Error('OpenRouter returned an unsuccessful response.');
      const choice: unknown = Array.isArray(data.choices) ? data.choices[0] : undefined;
      if (isRecord(choice) && choice.finish_reason === 'error') throw new Error('OpenRouter interrupted the response. Please retry.');
      const message = isRecord(choice) ? choice.message : undefined;
      if (!isRecord(message) || typeof message.content !== 'string' || !message.content.trim()) {
        throw new Error('OpenRouter returned no text. Try another model.');
      }
      if (message.content.length > MAX_ANSWER) throw new Error('OpenRouter response exceeded the size limit.');
      return { content: message.content, totalMs: Date.now() - started, firstTokenMs: null, completionTokens: usageTokens(data.usage), costUsd: reportedCost(data.usage) };
    });
  }
}
