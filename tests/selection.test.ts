import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App, Editor, MarkdownFileInfo, Menu, MenuItem, PluginManifest, WorkspaceLeaf } from 'obsidian';
import { ChatView, VIEW_TYPE } from '../src/chat-view';
import OpenRouterPlugin from '../src/main';
import { deferred, host, jsonResponse, settings } from './helpers';
import { notices, Platform } from './obsidian-mock';

afterEach(() => { Platform.isMobileApp = false; vi.unstubAllGlobals(); document.body.replaceChildren(); notices.length = 0; });

async function chat(fetcher: typeof fetch = vi.fn(async () => jsonResponse())) {
  const plugin = host(fetcher);
  const view = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
  await view.onOpen();
  document.body.append(view.contentEl);
  return { plugin, view, input: view.contentEl.querySelector('textarea')! };
}

function attachment(view: ChatView) { return view.contentEl.querySelector<HTMLElement>('.openrouter-attached-selection')!; }

describe('selection in chat', () => {
  it('stages inert text without sending or overwriting the instruction draft', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { view, plugin, input } = await chat(fetcher);
    input.value = 'Expand on this';
    const selection = '<img src="https://attacker.invalid/pixel">\n![[Private note]]\n```js\nalert(1)\n```';
    expect(view.addSelection(selection)).toBe(true);
    expect(attachment(view).hidden).toBe(false);
    expect(attachment(view).querySelector('.openrouter-selection-preview')?.textContent).toBe(selection);
    expect(attachment(view).querySelectorAll('img,script,[src],iframe,a')).toHaveLength(0);
    expect(input.value).toBe('Expand on this');
    expect(document.activeElement).toBe(input);
    expect(fetcher).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    await view.onClose();
  });

  it('requires an instruction and then includes the exact selection in protected chat history', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse('Expanded'));
    const { view, input } = await chat(fetcher);
    const text = '  indented note\nsecond line  ';
    view.addSelection(text);
    await view.send();
    expect(fetcher).not.toHaveBeenCalled();
    expect(attachment(view).hidden).toBe(false);
    view.contentEl.querySelector<HTMLInputElement>('.openrouter-sensitive-label input')!.click();
    input.value = 'Expand on this';
    await view.send();
    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(first.messages).toEqual([
      { role: 'system', content: settings().systemMessage },
      { role: 'user', content: `Selected text (context):\n\n${text}\n\nMy instruction:\nExpand on this` }
    ]);
    expect(first.provider).toEqual({ zdr: true, data_collection: 'deny' });
    expect(attachment(view).hidden).toBe(true);
    expect(view.contentEl.querySelector('.openrouter-message-user .openrouter-selection-preview')?.textContent).toBe(text);
    expect(view.contentEl.querySelector<HTMLInputElement>('.openrouter-sensitive-label input')!.disabled).toBe(true);
    input.value = 'Make it shorter'; await view.send();
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(second.messages).toHaveLength(4);
    expect(second.messages[1]).toEqual(first.messages[1]);
    expect(second.messages[3].content).toBe('Make it shorter');
    expect(second.provider.zdr).toBe(true);
    await view.onClose();
  });

  it('does not replace an existing attachment and can remove it before an ordinary request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse());
    const { view, input } = await chat(fetcher);
    view.addSelection('first excerpt');
    expect(view.addSelection('second excerpt')).toBe(false);
    expect(attachment(view).textContent).toContain('first excerpt');
    expect(attachment(view).textContent).not.toContain('second excerpt');
    expect(notices.at(-1)).toContain('already attached');
    view.contentEl.querySelector<HTMLButtonElement>('.openrouter-remove-selection')!.click();
    input.value = 'Ordinary question'; await view.send();
    const content = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[1].content;
    expect(content).toBe('Ordinary question');
    await view.onClose();
  });

  it('keeps the attachment if no model is selected', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { plugin, view, input } = await chat(fetcher);
    plugin.settings.cachedModels = []; plugin.publish();
    view.addSelection('selected excerpt'); input.value = 'Explain';
    await view.send();
    expect(attachment(view).textContent).toContain('selected excerpt');
    expect(input.value).toBe('Explain');
    expect(fetcher).not.toHaveBeenCalled();
    await view.onClose();
  });

  it('restores a failed selection draft for explicit retry and does not commit failed context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => jsonResponse());
    const { view, input } = await chat(fetcher);
    view.addSelection('selected excerpt'); input.value = 'Explain';
    await view.send();
    expect(attachment(view).textContent).toContain('selected excerpt');
    expect(input.value).toBe('Explain');
    await view.send();
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).messages).toHaveLength(2);
    expect(attachment(view).hidden).toBe(true);
    await view.onClose();
  });

  it('cannot silently attach a failed excerpt to a new draft typed during a request', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise).mockImplementation(async () => jsonResponse());
    const { view, input } = await chat(fetcher);
    view.addSelection('old private excerpt'); input.value = 'Explain';
    const request = view.send();
    expect(view.addSelection('another excerpt')).toBe(false);
    input.value = 'New unrelated question';
    pending.reject(new Error('offline')); await request;
    expect(attachment(view).hidden).toBe(true);
    expect(input.value).toBe('New unrelated question');
    await view.send();
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('excerpt');
    await view.onClose();
  });

  it('clear drops staged context; clearing in flight cannot resurrect the submitted selection', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise).mockImplementation(async () => jsonResponse());
    const { view, input } = await chat(fetcher);
    view.addSelection('staged text'); view.clear();
    expect(attachment(view).hidden).toBe(true);
    view.addSelection('old private excerpt'); input.value = 'Explain';
    const request = view.send(); view.clear();
    pending.resolve(jsonResponse('late')); await request;
    expect(attachment(view).hidden).toBe(true);
    input.value = 'New question'; await view.send();
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('old private');
    await view.onClose();
  });

  it('closing drops staged text and refuses late attachments', async () => {
    const { view } = await chat();
    view.addSelection('private excerpt'); await view.onClose();
    expect(view.addSelection('late excerpt')).toBe(false);
    await view.onOpen();
    expect(attachment(view).hidden).toBe(true);
    expect(view.contentEl.textContent).not.toContain('private excerpt');
    await view.onClose();
  });
});

describe('editor selection entry points', () => {
  async function setup(existing = false) {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse());
    vi.stubGlobal('fetch', fetcher);
    const on = vi.fn();
    const leaf = {
      app: {} as App, view: null as ChatView | null,
      setViewState: vi.fn(async (_state: unknown): Promise<void> => undefined),
      loadIfDeferred: vi.fn(async () => undefined)
    };
    const workspace = {
      on, detachLeavesOfType: vi.fn(), getLeavesOfType: vi.fn(() => existing ? [leaf] : []),
      getRightLeaf: vi.fn(() => leaf), getLeaf: vi.fn(() => leaf), revealLeaf: vi.fn(async () => undefined)
    };
    const app = {
      secretStorage: { getSecret: () => 'dummy-key', setSecret: vi.fn() }, workspace
    } as unknown as App;
    leaf.app = app;
    const plugin = new OpenRouterPlugin(app, { id: 'openrouter' } as PluginManifest);
    vi.mocked(plugin.loadData).mockResolvedValue({ ...settings(), secretName: 'key', lastModelUpdate: Date.now() });
    await plugin.onload();
    const view = new ChatView(leaf as unknown as WorkspaceLeaf, plugin);
    await view.onOpen(); leaf.view = view;
    document.body.append(view.contentEl);
    const command = vi.mocked(plugin.addCommand).mock.calls.map(([value]) => value).find(value => value.id === 'add-selection-to-chat')!;
    const getSelection = vi.fn(() => 'selected passage');
    const getValue = vi.fn(() => 'entire private note');
    const editor = { getSelection, getValue } as unknown as Editor;
    const context = {} as MarkdownFileInfo;
    return { plugin, view, workspace, leaf, command, editor, context, getSelection, getValue, fetcher };
  }

  it('command availability checks do nothing and execution captures selection before focus changes', async () => {
    const state = await setup();
    const { plugin, view, workspace, command, editor, context, getSelection, getValue, fetcher, leaf } = state;
    expect(command.editorCheckCallback!(true, editor, context)).toBe(true);
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    const opening = deferred<void>(); leaf.setViewState.mockImplementationOnce(() => opening.promise);
    expect(command.editorCheckCallback!(false, editor, context)).toBe(true);
    getSelection.mockReturnValue('later selection');
    opening.resolve();
    await vi.waitFor(() => expect(attachment(view).hidden).toBe(false));
    expect(attachment(view).textContent).toContain('selected passage');
    expect(attachment(view).textContent).not.toContain('later selection');
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE, active: true });
    expect(leaf.loadIfDeferred).toHaveBeenCalledOnce();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(getValue).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await view.onClose(); plugin.onunload();
  });

  it('hides the command and editor menu action when there is no non-empty selection', async () => {
    const { plugin, view, command, editor, context, getSelection, workspace } = await setup();
    getSelection.mockReturnValue(' \n ');
    expect(command.editorCheckCallback!(true, editor, context)).toBe(false);
    expect(command.editorCheckCallback!(false, editor, context)).toBe(false);
    const callback = workspace.on.mock.calls.find(([event]) => event === 'editor-menu')![1];
    const menu = { addItem: vi.fn() };
    callback(menu, editor, context);
    expect(menu.addItem).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    await view.onClose(); plugin.onunload();
  });

  it.each([false, true])('reuses existing chat and captures editor-menu text on mobile=%s', async mobile => {
    Platform.isMobileApp = mobile;
    const { plugin, view, editor, context, getSelection, workspace, leaf, fetcher } = await setup(true);
    const callback = workspace.on.mock.calls.find(([event]) => event === 'editor-menu')![1];
    let action: (() => void) | undefined;
    const item = {
      setTitle: vi.fn(function () { return item; }), setIcon: vi.fn(function () { return item; }),
      onClick: vi.fn((value: () => void) => { action = value; return item; })
    };
    const menu = { addItem: (build: (item: MenuItem) => void) => build(item as unknown as MenuItem) } as unknown as Menu;
    callback(menu, editor, context);
    expect(item.setTitle).toHaveBeenCalledWith('Add selection to OpenRouter chat');
    getSelection.mockReturnValue('changed after menu'); action!();
    await vi.waitFor(() => expect(attachment(view).hidden).toBe(false));
    expect(attachment(view).textContent).toContain('selected passage');
    expect(leaf.setViewState).not.toHaveBeenCalled();
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(plugin.registerEvent).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    await view.onClose(); plugin.onunload();
  });

  it('opens new mobile chat in a full tab without replacing the note or using the sidebar', async () => {
    Platform.isMobileApp = true;
    const { plugin, view, workspace, leaf } = await setup();
    expect(await plugin.activateView()).toBe(view);
    expect(workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE, active: true });
    await view.onClose(); plugin.onunload();
  });

  it('does not attach after unloading while the chat view is opening', async () => {
    const { plugin, view, command, editor, context, leaf } = await setup();
    const opening = deferred<void>(); leaf.setViewState.mockImplementationOnce(() => opening.promise);
    command.editorCheckCallback!(false, editor, context);
    plugin.onunload(); opening.resolve();
    await vi.waitFor(() => expect(leaf.loadIfDeferred).toHaveBeenCalled());
    expect(attachment(view).hidden).toBe(true);
    await view.onClose();
  });
});
