import { PluginSettingTab, SecretComponent, Setting, type App } from 'obsidian';
import type OpenRouterPlugin from './main';
import { element, ModelPicker } from './ui';

export class OpenRouterSettingTab extends PluginSettingTab {
  private picker: ModelPicker | null = null;

  constructor(app: App, private host: OpenRouterPlugin) { super(app, host); }

  display(): void {
    this.picker?.destroy();
    this.containerEl.replaceChildren();
    element(this.containerEl, 'h2', '', 'OpenRouter Chat');
    const credential = new Setting(this.containerEl).setName('API key').setDesc('Create a secret named openrouter-api-key (or another label), paste your OpenRouter API key as its value, then select it here. The name is a label you choose.');
    new SecretComponent(this.app, credential.controlEl).setValue(this.host.settings.secretName).onChange(value => {
      this.host.settings.secretName = value ?? '';
      void this.host.saveSettings();
    });
    new Setting(this.containerEl).setName('System message').setDesc('Sent with each request. Changes apply to the next message.').addTextArea(input => {
      input.setValue(this.host.settings.systemMessage).onChange(value => {
        this.host.settings.systemMessage = value;
        void this.host.saveSettings();
      });
    });
    element(this.containerEl, 'h3', '', 'Default model');
    this.picker = new ModelPicker(this.containerEl, this.host, model => {
      this.host.settings.defaultModel = model;
      void this.host.saveSettings();
    });
    if (this.host.client.supportsStreaming) {
      new Setting(this.containerEl).setName('Stream responses').setDesc('Display text as it arrives.').addToggle(toggle => {
        toggle.setValue(this.host.settings.useStreaming).onChange(value => {
          this.host.settings.useStreaming = value;
          void this.host.saveSettings();
        });
      });
    } else {
      new Setting(this.containerEl).setName('Responses on mobile').setDesc('Replies appear when complete. Streaming is unavailable on mobile; your desktop streaming preference is preserved. Stop and timeout discard the reply, but cannot stop an already-sent mobile request.');
    }
    new Setting(this.containerEl).setName('Sensitive notes by default').setDesc('Start new chats and note prompts with Sensitive notes enabled. Requires Zero Data Retention hosts and denies data collection; disables web search and response caching. Availability and cost may change. You can switch it per chat or prompt.').addToggle(toggle => {
      toggle.setValue(this.host.settings.sensitiveNotesByDefault).onChange(value => {
        this.host.settings.sensitiveNotesByDefault = value;
        void this.host.saveSettings();
      });
    });
    this.numberSetting('Request timeout', 'Maximum request duration in seconds (10–600).', 'requestTimeoutSeconds', 10, 600);
    this.numberSetting('Maximum output tokens', 'Limits response length and potential cost (64–32768). Provider charges and context limits still apply.', 'maxOutputTokens', 64, 32768);
    element(this.containerEl, 'p', 'openrouter-privacy-hint', 'The secret store is not isolation from other installed plugins or software on your device. Chat is kept in memory and is sent with subsequent messages. Clear chat cancels the pending request and discards this history.');
  }

  private numberSetting(name: string, description: string, field: 'requestTimeoutSeconds' | 'maxOutputTokens', min: number, max: number): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addText(input => {
      input.inputEl.type = 'number';
      input.inputEl.min = String(min);
      input.inputEl.max = String(max);
      input.inputEl.step = '1';
      input.setValue(String(this.host.settings[field])).onChange(value => {
        const number = Number(value);
        const valid = value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max;
        input.inputEl.setCustomValidity(valid ? '' : `Enter a whole number between ${min} and ${max}.`);
        input.inputEl.reportValidity();
        if (valid) { this.host.settings[field] = number; void this.host.saveSettings(); }
      });
    });
  }

  hide(): void { this.picker?.destroy(); this.picker = null; }
}
