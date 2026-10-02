import { Notice, Platform, Plugin, type Editor, type MarkdownFileInfo } from 'obsidian';
import { OpenRouterClient, errorMessage, isAbort } from './api';
import { ChatView, VIEW_TYPE } from './chat-view';
import { PromptModal } from './prompt-modal';
import { migrateSettings, readSettings } from './settings';
import { OpenRouterSettingTab } from './settings-tab';
import type { Settings } from './types';
import { createMobileFetch } from './mobile-transport';

export default class OpenRouterPlugin extends Plugin {
  settings: Settings = readSettings(null);
  client!: OpenRouterClient;
  private observers = new Set<() => void>();
  private modals = new Set<PromptModal>();
  private stopped = false;
  private refresh: Promise<boolean> | null = null;
  private saves: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.stopped = false;
    try {
      if (!this.app.secretStorage) throw new Error('Secret storage unavailable.');
      this.settings = await migrateSettings(await this.loadData(), this.app.secretStorage, data => this.saveData(data));
    } catch {
      new Notice('OpenRouter could not load or migrate its settings. Check vault storage access and use Obsidian 1.11.4 or newer.');
      throw new Error('OpenRouter settings migration failed.');
    }
    this.client = new OpenRouterClient(
      () => this.settings.secretName ? this.app.secretStorage.getSecret(this.settings.secretName) : null,
      Platform.isMobileApp ? createMobileFetch() : fetch,
      !Platform.isMobileApp
    );
    this.registerView(VIEW_TYPE, leaf => new ChatView(leaf, this));
    this.addRibbonIcon('message-square', 'OpenRouter Chat', () => { void this.activateView(); });
    this.addCommand({ id: 'open-openrouter-chat', name: 'Open chat', callback: () => { void this.activateView(); } });
    this.addCommand({ id: 'refresh-openrouter-models', name: 'Refresh models', callback: () => { void this.refreshModels(); } });
    this.addCommand({ id: 'insert-openrouter-response', name: 'Generate from selection and insert response', editorCallback: (editor, context) => this.openPrompt(editor, context) });
    this.addSettingTab(new OpenRouterSettingTab(this.app, this));
    // Registration is not blocked by an offline/stalled model-list request.
    if (!this.settings.cachedModels.length || Date.now() - this.settings.lastModelUpdate > 86_400_000) void this.refreshModels();
  }

  private openPrompt(editor: Editor, context: MarkdownFileInfo): void {
    const prompt = editor.getSelection();
    if (!prompt) { new Notice('Select text to use as the prompt.'); return; }
    const originalDocument = editor.getValue();
    const originalFile = context.file;
    const from = { ...editor.getCursor('from') };
    const to = { ...editor.getCursor('to') };
    const modal = new PromptModal(this.app, this, prompt, response => {
      if (context.file !== originalFile || editor.getValue() !== originalDocument) throw new Error('The note changed while generating. Copy the response and insert it manually.');
      editor.replaceRange(response, from, to);
    }, () => this.modals.delete(modal));
    this.modals.add(modal);
    modal.open();
  }

  async saveSettings(): Promise<void> {
    const snapshot = readSettings(this.settings);
    const save = this.saves.then(() => this.saveData(snapshot));
    this.saves = save.catch(() => { new Notice('OpenRouter settings could not be saved. Check vault storage access.'); });
    await this.saves;
  }

  subscribeModels(callback: () => void): () => void {
    this.observers.add(callback);
    return () => this.observers.delete(callback);
  }

  async refreshModels(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      try {
        const models = await this.client.models();
        if (this.stopped) return false;
        this.settings.cachedModels = models;
        this.settings.lastModelUpdate = Date.now();
        await this.saveSettings();
        if (this.stopped) return false;
        for (const observer of this.observers) observer();
        return true;
      } catch (error) {
        if (!this.stopped && !isAbort(error)) new Notice(errorMessage(error));
        return false;
      }
    })();
    try { return await this.refresh; }
    finally { this.refresh = null; }
  }

  async activateView(): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? workspace.getRightLeaf(false) ?? workspace.getLeaf('split');
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  onunload(): void {
    this.stopped = true;
    this.client?.dispose();
    for (const modal of this.modals) modal.close();
    this.modals.clear();
    this.observers.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}
