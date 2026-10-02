import { vi } from 'vitest';
import { OpenRouterClient } from '../src/api';
import { readSettings } from '../src/settings';
import { parseModels } from '../src/models';
import type { PluginHost } from '../src/ui';

export const models = parseModels({ data: [
  { id: 'vendor/paid', name: 'Paid', pricing: { prompt: '0.001', completion: '0.002' } },
  { id: 'vendor/free:free', name: 'Zero cost', pricing: { prompt: '0', completion: '0' } }
] });

export function settings() {
  return { ...readSettings(null), cachedModels: models, defaultModel: 'vendor/paid', useStreaming: false };
}

export function jsonResponse(content = 'Answer'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 5 } }), { headers: { 'Content-Type': 'application/json' } });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function host(fetcher: typeof fetch = vi.fn(async () => jsonResponse())): PluginHost & { publish(): void } {
  const listeners = new Set<() => void>();
  return {
    settings: settings(),
    client: new OpenRouterClient(() => 'dummy-key', fetcher),
    saveSettings: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => true),
    subscribeModels(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    publish() { for (const listener of listeners) listener(); }
  };
}

export function streamResponse(text: string, chunkSize = 1): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(bytes.length, offset + chunkSize);
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
