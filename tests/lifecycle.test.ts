import { describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { Conversation } from '../src/conversation';
import { ChatView } from '../src/chat-view';
import { PromptModal } from '../src/prompt-modal';
import { deferred, host, jsonResponse, settings } from './helpers';

describe('conversation isolation', () => {
  it('clearing cancels a request; late output cannot appear in later request history', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => old.promise).mockImplementation(async () => jsonResponse('new answer'));
    const plugin = host(fetcher);
    const conversation = new Conversation(plugin.client);
    const request = conversation.send('old private prompt', 'vendor/paid', settings());
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    conversation.clear();
    await rejection;
    expect(conversation.busy).toBe(false);
    await conversation.send('new prompt', 'vendor/paid', settings());
    old.resolve(jsonResponse('old private answer'));
    await Promise.resolve();
    await conversation.send('next prompt', 'vendor/paid', settings());
    const bodies = fetcher.mock.calls.slice(1).map(([, init]) => String(init?.body));
    expect(bodies.every(body => !body.includes('old private'))).toBe(true);
    expect(JSON.parse(bodies[1]!).messages.map((m: { content: string }) => m.content)).toEqual(['You are a helpful assistant.', 'new prompt', 'new answer', 'next prompt']);
  });
  it('failed exchanges are not silently resent as history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network')).mockImplementation(async () => jsonResponse());
    const conversation = new Conversation(host(fetcher).client);
    await expect(conversation.send('failed prompt', 'vendor/paid', settings())).rejects.toThrow();
    await conversation.send('successful prompt', 'vendor/paid', settings());
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('failed prompt');
  });
  it('prevents overlapping sends', async () => {
    const response = deferred<Response>();
    const conversation = new Conversation(host(() => response.promise).client);
    const request = conversation.send('one', 'vendor/paid', settings());
    await expect(conversation.send('two', 'vendor/paid', settings())).rejects.toThrow('already');
    response.resolve(jsonResponse()); await request;
  });
  it('closing the view aborts requests and prevents late UI updates', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => old.promise);
    const plugin = host(fetcher);
    const view = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    await view.onOpen();
    view.contentEl.querySelector('textarea')!.value = 'prompt';
    const request = view.send();
    await view.onClose();
    old.resolve(jsonResponse('late'));
    await request;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(view.contentEl.textContent).toBe('');
  });
  it('clear resets the UI immediately while a request is pending', async () => {
    const old = deferred<Response>();
    const view = new ChatView({ app: {} } as unknown as WorkspaceLeaf, host(() => old.promise));
    await view.onOpen();
    view.contentEl.querySelector('textarea')!.value = 'prompt';
    const request = view.send();
    view.clear();
    expect(view.contentEl.querySelector('.openrouter-send-button')?.hasAttribute('disabled')).toBe(false);
    old.resolve(jsonResponse('late'));
    await request;
    expect(view.contentEl.querySelector('.openrouter-message')).toBeNull();
    expect(view.contentEl.querySelector('.openrouter-empty-state')).not.toBeNull();
    await view.onClose();
  });
});

describe('prompt modal', () => {
  it('disables and clears the previous result on regeneration and after failure', async () => {
    const next = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => jsonResponse('first answer')).mockImplementationOnce(() => next.promise);
    const insert = vi.fn();
    const modal = new PromptModal({} as App, host(fetcher), 'prompt', insert);
    modal.onOpen();
    const button = modal.contentEl.querySelector<HTMLButtonElement>('.openrouter-modal-insert')!;
    await modal.generate();
    expect(button.disabled).toBe(false);
    const second = modal.generate();
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new Event('click'));
    expect(insert).not.toHaveBeenCalled();
    next.reject(new Error('network failure')); await second;
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new Event('click'));
    expect(insert).not.toHaveBeenCalled();
    expect(modal.contentEl.querySelector('.openrouter-modal-response')?.textContent).not.toContain('first answer');
    modal.onClose();
  });
  it('inserts only the current successful result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => jsonResponse('first')).mockImplementationOnce(async () => jsonResponse('second'));
    const insert = vi.fn();
    const modal = new PromptModal({} as App, host(fetcher), 'prompt', insert);
    modal.onOpen(); await modal.generate(); await modal.generate();
    modal.contentEl.querySelector<HTMLButtonElement>('.openrouter-modal-insert')!.click();
    expect(insert).toHaveBeenCalledExactlyOnceWith('second');
  });
  it('cancels a pending request when dismissed', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => old.promise);
    const modal = new PromptModal({} as App, host(fetcher), 'prompt', vi.fn());
    modal.onOpen(); const request = modal.generate(); modal.onClose();
    old.resolve(jsonResponse('late')); await request;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(modal.contentEl.textContent).toBe('');
  });
});
