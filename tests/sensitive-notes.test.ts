import { describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { OpenRouterClient } from '../src/api';
import { ChatView } from '../src/chat-view';
import { Conversation } from '../src/conversation';
import { PromptModal } from '../src/prompt-modal';
import { readSettings } from '../src/settings';
import { deferred, host, jsonResponse, settings, streamResponse } from './helpers';

function sensitiveToggle(parent: HTMLElement): HTMLInputElement {
  return parent.querySelector<HTMLInputElement>('.openrouter-sensitive-label input')!;
}

function change(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked;
  input.dispatchEvent(new Event('change'));
}

function body(init?: RequestInit) {
  return JSON.parse(String(init?.body));
}

function expectSensitive(init?: RequestInit): void {
  expect(body(init)).toMatchObject({ provider: { zdr: true, data_collection: 'deny' }, plugins: [{ id: 'web', enabled: false }] });
  expect(new Headers(init?.headers).get('X-OpenRouter-Cache')).toBe('false');
}

describe('sensitive request policy', () => {
  it('defaults off for new and legacy settings and persists only a boolean opt-in', () => {
    for (const input of [null, {}, { sensitiveNotesByDefault: 'true' }, { sensitiveNotesByDefault: false }]) {
      expect(readSettings(input).sensitiveNotesByDefault).toBe(false);
    }
    expect(readSettings(readSettings({ sensitiveNotesByDefault: true })).sensitiveNotesByDefault).toBe(true);
  });

  it.each([false, true])('enforces sensitive routing and disables search/cache with streaming=%s', async useStreaming => {
    const fetcher = vi.fn<typeof fetch>(async () => useStreaming
      ? streamResponse('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n')
      : jsonResponse());
    const config = { ...settings(), useStreaming, useWebSearch: true };
    const original = structuredClone(config);
    const onText = vi.fn();
    const result = await new OpenRouterClient(() => 'dummy', fetcher).complete({
      model: config.defaultModel, settings: config, sensitiveNotes: true,
      messages: [{ role: 'user', content: 'private note' }], onText
    });
    const init = fetcher.mock.calls[0]?.[1];
    expectSensitive(init);
    expect(body(init)).toMatchObject({ model: 'vendor/paid', stream: useStreaming, messages: [{ role: 'user', content: 'private note' }] });
    expect(config).toEqual(original);
    expect(result.content).toBe('Answer');
    expect(onText).toHaveBeenCalledTimes(useStreaming ? 1 : 0);
  });

  it('does not retain sensitive flags on subsequent ordinary requests or override stricter account defaults', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse());
    const client = new OpenRouterClient(() => 'dummy', fetcher);
    const config = { ...settings(), sensitiveNotesByDefault: true, useWebSearch: true };
    const request = { model: config.defaultModel, settings: config, messages: [] };
    await client.complete({ ...request, sensitiveNotes: true });
    await client.complete({ ...request, sensitiveNotes: false });
    await client.complete(request);
    expectSensitive(fetcher.mock.calls[0]?.[1]);
    for (const [, init] of fetcher.mock.calls.slice(1)) {
      expect(body(init).provider).toBeUndefined();
      expect(body(init).plugins).toEqual([{ id: 'web' }]);
      expect(new Headers(init?.headers).has('X-OpenRouter-Cache')).toBe(false);
    }
  });

  it.each([404, 503])('never retries or removes privacy restrictions when routing fails with HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('private provider error', { status }));
    await expect(new OpenRouterClient(() => 'dummy', fetcher).complete({
      model: 'vendor/paid', settings: settings(), messages: [], sensitiveNotes: true
    })).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledOnce();
    expectSensitive(fetcher.mock.calls[0]?.[1]);
  });

  it('keeps free-only enforcement and the selected model while suppressing saved web search', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse());
    const client = new OpenRouterClient(() => 'dummy', fetcher);
    const config = { ...settings(), showFreeModelsOnly: true, useWebSearch: true };
    const request = { settings: config, messages: [], sensitiveNotes: true };
    await expect(client.complete({ ...request, model: 'vendor/paid' })).rejects.toThrow('verified free');
    expect(fetcher).not.toHaveBeenCalled();
    await client.complete({ ...request, model: 'vendor/free:free' });
    expectSensitive(fetcher.mock.calls[0]?.[1]);
    expect(body(fetcher.mock.calls[0]?.[1]).model).toBe('vendor/free:free');
  });

  it('rejects the web-search model variant before sending sensitive text', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const config = settings();
    config.cachedModels = [{ ...config.cachedModels[0]!, id: 'vendor/paid:online' }];
    await expect(new OpenRouterClient(() => 'dummy', fetcher).complete({
      model: 'vendor/paid:online', settings: config, messages: [], sensitiveNotes: true
    })).rejects.toThrow(':online');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('sensitive conversation history', () => {
  it('requires sensitive routing for all follow-ups until history is cleared', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse('private answer'));
    const conversation = new Conversation(host(fetcher).client);
    await conversation.send('private note', 'vendor/paid', settings(), { sensitiveNotes: true });
    expect(conversation.requiresSensitiveNotes).toBe(true);
    for (const options of [{}, { sensitiveNotes: false }]) {
      await expect(conversation.send('follow-up', 'vendor/paid', settings(), options)).rejects.toThrow('Clear chat');
    }
    expect(fetcher).toHaveBeenCalledOnce();
    await conversation.send('sensitive follow-up', 'vendor/paid', settings(), { sensitiveNotes: true });
    expectSensitive(fetcher.mock.calls[1]?.[1]);
    expect(body(fetcher.mock.calls[1]?.[1]).messages).toContainEqual({ role: 'user', content: 'private note' });
    conversation.clear();
    expect(conversation.requiresSensitiveNotes).toBe(false);
    await conversation.send('ordinary question', 'vendor/paid', settings());
    expect(body(fetcher.mock.calls[2]?.[1]).provider).toBeUndefined();
    expect(body(fetcher.mock.calls[2]?.[1]).messages).toEqual([
      { role: 'system', content: settings().systemMessage }, { role: 'user', content: 'ordinary question' }
    ]);
  });

  it('can enable protection mid-conversation and protects the entire request context', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse());
    const conversation = new Conversation(host(fetcher).client);
    await conversation.send('ordinary question', 'vendor/paid', settings());
    expect(conversation.requiresSensitiveNotes).toBe(false);
    await conversation.send('private follow-up', 'vendor/paid', settings(), { sensitiveNotes: true });
    expectSensitive(fetcher.mock.calls[1]?.[1]);
    expect(body(fetcher.mock.calls[1]?.[1]).messages).toHaveLength(4);
    expect(conversation.requiresSensitiveNotes).toBe(true);
  });

  it('does not retain or lock failed sensitive exchanges', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => jsonResponse());
    const conversation = new Conversation(host(fetcher).client);
    await expect(conversation.send('failed private note', 'vendor/paid', settings(), { sensitiveNotes: true })).rejects.toThrow();
    expect(conversation.requiresSensitiveNotes).toBe(false);
    await conversation.send('ordinary question', 'vendor/paid', settings());
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('failed private note');
  });

  it('clearing a pending sensitive request cannot restore its history or privacy lock on late completion', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise).mockImplementation(async () => jsonResponse());
    const conversation = new Conversation(host(fetcher).client);
    const result = conversation.send('abandoned private note', 'vendor/paid', settings(), { sensitiveNotes: true });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    conversation.clear();
    await assertion;
    pending.resolve(jsonResponse('abandoned private answer'));
    await conversation.send('ordinary question', 'vendor/paid', settings());
    expect(conversation.requiresSensitiveNotes).toBe(false);
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('abandoned');
  });

  it('stopping a later request does not remove the protection on earlier sensitive history', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => jsonResponse()).mockImplementationOnce(() => pending.promise);
    const conversation = new Conversation(host(fetcher).client);
    await conversation.send('private note', 'vendor/paid', settings(), { sensitiveNotes: true });
    const result = conversation.send('cancelled follow-up', 'vendor/paid', settings(), { sensitiveNotes: true });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    conversation.cancel();
    await assertion;
    expect(conversation.requiresSensitiveNotes).toBe(true);
    await expect(conversation.send('ordinary follow-up', 'vendor/paid', settings())).rejects.toThrow('Clear chat');
    pending.resolve(jsonResponse());
  });
});

describe('sensitive notes controls', () => {
  it('uses local opt-in, suppresses and restores saved search, and leaves other chats alone', async () => {
    const plugin = host();
    plugin.settings.useWebSearch = true;
    const first = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    const second = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    await first.onOpen(); await second.onOpen();
    const toggle = sensitiveToggle(first.contentEl);
    const search = first.contentEl.querySelector<HTMLInputElement>('.openrouter-websearch-label input')!;
    expect(toggle.checked).toBe(false);
    expect(search.checked).toBe(true);
    change(toggle, true);
    expect(search.checked).toBe(false);
    expect(search.disabled).toBe(true);
    change(search, true);
    expect(search.checked).toBe(false);
    expect(plugin.settings.useWebSearch).toBe(true);
    expect(plugin.settings.sensitiveNotesByDefault).toBe(false);
    expect(sensitiveToggle(second.contentEl).checked).toBe(false);
    change(toggle, false);
    expect(search.checked).toBe(true);
    expect(search.disabled).toBe(false);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    await first.onClose(); await second.onClose();
  });

  it('locks sensitive chat history, resists changes while busy, and allows normal requests after clear', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise).mockImplementation(async () => jsonResponse());
    const view = new ChatView({ app: {} } as unknown as WorkspaceLeaf, host(fetcher));
    await view.onOpen();
    const toggle = sensitiveToggle(view.contentEl);
    change(toggle, true);
    view.contentEl.querySelector('textarea')!.value = 'private note';
    const result = view.send();
    expect(toggle.disabled).toBe(true);
    change(toggle, false);
    expect(toggle.checked).toBe(true);
    expectSensitive(fetcher.mock.calls[0]?.[1]);
    pending.resolve(jsonResponse('private answer'));
    await result;
    expect(toggle.disabled).toBe(true);
    expect(view.contentEl.querySelector('.openrouter-sensitive-notes')?.textContent).toContain('Clear chat');
    expect(view.contentEl.textContent).toContain('ZDR required');
    change(toggle, false);
    expect(toggle.checked).toBe(true);
    view.clear();
    expect(toggle.disabled).toBe(false);
    change(toggle, false);
    view.contentEl.querySelector('textarea')!.value = 'ordinary question';
    await view.send();
    expect(body(fetcher.mock.calls[1]?.[1]).provider).toBeUndefined();
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('private');
    await view.onClose();
  });

  it('applies the saved default to new chats and selection prompts without changing existing views', async () => {
    const plugin = host();
    const first = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    await first.onOpen();
    plugin.settings.sensitiveNotesByDefault = true;
    const second = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    await second.onOpen();
    const modal = new PromptModal({} as App, plugin, 'private selection', vi.fn());
    modal.onOpen();
    expect(sensitiveToggle(first.contentEl).checked).toBe(false);
    expect(sensitiveToggle(second.contentEl).checked).toBe(true);
    expect(sensitiveToggle(modal.contentEl).checked).toBe(true);
    await first.onClose(); await second.onClose(); modal.onClose();
  });

  it('uses the selection toggle per generation and invalidates the previous insertable answer on privacy changes', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => jsonResponse('ordinary answer'))
      .mockImplementationOnce(() => pending.promise).mockImplementation(async () => jsonResponse('next ordinary answer'));
    const insert = vi.fn();
    const plugin = host(fetcher);
    plugin.settings.useWebSearch = true;
    const modal = new PromptModal({} as App, plugin, 'selected note', insert);
    modal.onOpen();
    const toggle = sensitiveToggle(modal.contentEl);
    const insertButton = modal.contentEl.querySelector<HTMLButtonElement>('.openrouter-modal-insert')!;
    expect(toggle.checked).toBe(false);
    await modal.generate();
    expect(insertButton.disabled).toBe(false);
    expect(body(fetcher.mock.calls[0]?.[1]).provider).toBeUndefined();
    change(toggle, true);
    expect(insertButton.disabled).toBe(true);
    insertButton.dispatchEvent(new Event('click'));
    expect(insert).not.toHaveBeenCalled();
    expect(modal.contentEl.querySelector('.openrouter-modal-response')?.textContent).not.toContain('ordinary answer');
    const result = modal.generate();
    expect(toggle.disabled).toBe(true);
    change(toggle, false);
    expect(toggle.checked).toBe(true);
    expectSensitive(fetcher.mock.calls[1]?.[1]);
    pending.resolve(jsonResponse('sensitive answer'));
    await result;
    expect(toggle.disabled).toBe(false);
    expect(insertButton.disabled).toBe(false);
    change(toggle, false);
    expect(insertButton.disabled).toBe(true);
    await modal.generate();
    expect(body(fetcher.mock.calls[2]?.[1]).provider).toBeUndefined();
    expect(body(fetcher.mock.calls[2]?.[1]).plugins).toEqual([{ id: 'web' }]);
    insertButton.click();
    expect(insert).toHaveBeenCalledExactlyOnceWith('next ordinary answer');
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });
});
