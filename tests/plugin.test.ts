import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App, Editor, MarkdownFileInfo, PluginManifest, TFile } from 'obsidian';
import OpenRouterPlugin from '../src/main';
import { PromptModal } from '../src/prompt-modal';
import { deferred, jsonResponse, settings } from './helpers';

const manifest: PluginManifest = {
  id: 'openrouter', name: 'OpenRouter Chat', version: '1.1.0', minAppVersion: '1.11.4', author: 'AgileAndy', description: 'test'
};

function app(): App {
  const secrets = new Map<string, string>();
  return {
    secretStorage: { getSecret: (name: string) => secrets.get(name) ?? null, setSecret: (name: string, value: string) => secrets.set(name, value) },
    workspace: { detachLeavesOfType: vi.fn() }
  } as unknown as App;
}

afterEach(() => vi.unstubAllGlobals());

describe('plugin integration', () => {
  it('registers the interface without waiting for the catalog, and aborts refresh on unload', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const plugin = new OpenRouterPlugin(app(), manifest);
    await plugin.onload();
    expect(plugin.registerView).toHaveBeenCalled();
    expect(plugin.addCommand).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledOnce();
    plugin.onunload();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(new Response(JSON.stringify({ data: [{ id: 'late/model' }] })));
    await Promise.resolve();
    expect(plugin.settings.cachedModels).toEqual([]);
    expect(plugin.saveData).toHaveBeenCalledOnce();
  });
  it('migrates legacy credentials as part of startup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const instance = app();
    const plugin = new OpenRouterPlugin(instance, manifest);
    vi.mocked(plugin.loadData).mockResolvedValue({ apiKey: 'dummy-key', ...settings(), lastModelUpdate: Date.now() });
    await plugin.onload();
    expect(instance.secretStorage.getSecret(plugin.settings.secretName)).toBe('dummy-key');
    expect(JSON.stringify(vi.mocked(plugin.saveData).mock.calls)).not.toContain('dummy-key');
    plugin.onunload();
  });
  it('serializes saves and whitelists every persistence payload', async () => {
    const plugin = new OpenRouterPlugin(app(), manifest);
    Object.assign(plugin.settings, { apiKey: 'must-not-persist' });
    const first = deferred<void>();
    vi.mocked(plugin.saveData).mockImplementationOnce(() => first.promise);
    plugin.settings.systemMessage = 'first'; const one = plugin.saveSettings();
    plugin.settings.systemMessage = 'second'; const two = plugin.saveSettings();
    await Promise.resolve();
    expect(plugin.saveData).toHaveBeenCalledOnce();
    first.resolve(); await Promise.all([one, two]);
    expect(vi.mocked(plugin.saveData).mock.calls.map(([data]) => data.systemMessage)).toEqual(['first', 'second']);
    expect(JSON.stringify(vi.mocked(plugin.saveData).mock.calls)).not.toContain('must-not-persist');
  });
  it('recovers the save queue after a disk error', async () => {
    const plugin = new OpenRouterPlugin(app(), manifest);
    vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error('disk error'));
    await plugin.saveSettings(); await plugin.saveSettings();
    expect(plugin.saveData).toHaveBeenCalledTimes(2);
  });
  it('does not register or erase legacy settings if secret storage fails', async () => {
    const instance = app();
    instance.secretStorage.setSecret = () => { throw new Error('dummy-key storage failure'); };
    const plugin = new OpenRouterPlugin(instance, manifest);
    vi.mocked(plugin.loadData).mockResolvedValue({ apiKey: 'dummy-key' });
    await expect(plugin.onload()).rejects.toThrow('migration failed');
    expect(plugin.registerView).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
  });
});

describe('note insertion boundary', () => {
  async function openPrompt() {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('generated')));
    const instance = app(); instance.secretStorage.setSecret('key', 'dummy');
    const plugin = new OpenRouterPlugin(instance, manifest);
    vi.mocked(plugin.loadData).mockResolvedValue({ ...settings(), secretName: 'key', lastModelUpdate: Date.now() });
    await plugin.onload();
    let modal!: PromptModal;
    vi.spyOn(PromptModal.prototype, 'open').mockImplementation(function (this: PromptModal) { modal = this; this.onOpen(); });
    const editor = {
      getSelection: vi.fn(() => 'selected'), getValue: vi.fn(() => 'original note'),
      getCursor: vi.fn((side: string) => ({ line: 0, ch: side === 'from' ? 2 : 10 })), replaceRange: vi.fn()
    };
    const context = { file: { path: 'original.md' } as TFile };
    const command = vi.mocked(plugin.addCommand).mock.calls.map(([value]) => value).find(value => value.id === 'insert-openrouter-response')!;
    command.editorCallback!(editor as unknown as Editor, context as MarkdownFileInfo);
    await modal.generate();
    return { plugin, modal, editor, context };
  }
  it('uses the original range even if the cursor moves', async () => {
    const { plugin, modal, editor } = await openPrompt();
    editor.getCursor.mockReturnValue({ line: 5, ch: 0 });
    modal.contentEl.querySelector<HTMLButtonElement>('.openrouter-modal-insert')!.click();
    expect(editor.replaceRange).toHaveBeenCalledWith('generated', { line: 0, ch: 2 }, { line: 0, ch: 10 });
    plugin.onunload();
  });
  it('refuses insertion if the note was edited', async () => {
    const { plugin, modal, editor } = await openPrompt();
    editor.getValue.mockReturnValue('edited note');
    modal.contentEl.querySelector<HTMLButtonElement>('.openrouter-modal-insert')!.click();
    expect(editor.replaceRange).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('note changed');
    plugin.onunload();
  });
  it('refuses insertion after the editor switches to a different file', async () => {
    const { plugin, modal, editor, context } = await openPrompt();
    context.file = { path: 'other.md' } as TFile;
    modal.contentEl.querySelector<HTMLButtonElement>('.openrouter-modal-insert')!.click();
    expect(editor.replaceRange).not.toHaveBeenCalled();
    plugin.onunload();
  });
});
