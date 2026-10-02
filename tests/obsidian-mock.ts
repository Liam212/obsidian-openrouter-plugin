import { vi } from 'vitest';
import type { App, Command, PluginManifest, RequestUrlParam, RequestUrlResponse, WorkspaceLeaf } from 'obsidian';

export const Platform = { isMobileApp: false };
export const requestUrl = vi.fn<(request: RequestUrlParam) => Promise<RequestUrlResponse>>();

export const notices: string[] = [];
export class Notice { constructor(message: string) { notices.push(message); } }
export class ItemView {
  contentEl = document.createElement('div');
  app: App;
  constructor(leaf: WorkspaceLeaf) { this.app = (leaf as unknown as { app: App }).app; }
}
export class Modal {
  contentEl = document.createElement('div');
  constructor(public app: App) {}
  onOpen(): void {}
  onClose(): void {}
  open(): void { this.onOpen(); }
  close(): void { this.onClose(); }
}
export class Plugin {
  constructor(public app: App, public manifest: PluginManifest) {}
  loadData = vi.fn(async (): Promise<unknown> => null);
  saveData = vi.fn(async (_data: unknown) => undefined);
  registerView = vi.fn();
  addRibbonIcon = vi.fn();
  addCommand = vi.fn((command: Command) => command);
  addSettingTab = vi.fn();
}
export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: App, public plugin: unknown) {}
}
class Input {
  inputEl = document.createElement('input');
  setValue(value: string): this { this.inputEl.value = value; return this; }
  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
    return this;
  }
}
class Toggle {
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => void): this { return this; }
}
export class SecretComponent extends Input {
  constructor(_app: App, parent: HTMLElement) { super(); parent.append(this.inputEl); }
}
export class Setting {
  controlEl: HTMLElement;
  constructor(parent: HTMLElement) { this.controlEl = document.createElement('div'); parent.append(this.controlEl); }
  setName(_name: string): this { return this; }
  setDesc(_description: string): this { return this; }
  addText(callback: (input: Input) => void): this {
    const input = new Input(); this.controlEl.append(input.inputEl); callback(input); return this;
  }
  addTextArea(callback: (input: Input) => void): this { return this.addText(callback); }
  addToggle(callback: (toggle: Toggle) => void): this { callback(new Toggle()); return this; }
}
