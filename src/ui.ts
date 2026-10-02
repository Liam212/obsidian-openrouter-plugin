import type { OpenRouterClient } from './api';
import { filterModels, modelLabel } from './models';
import type { Settings } from './types';
import { costDescription, formatCost } from './cost';

export interface PluginHost {
  settings: Settings;
  client: OpenRouterClient;
  saveSettings(): Promise<void>;
  refreshModels(): Promise<boolean>;
  subscribeModels(callback: () => void): () => void;
}

export function element<K extends keyof HTMLElementTagNameMap>(parent: Node, tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = parent.ownerDocument!.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

export function button(parent: Node, text: string, cls: string, callback: () => void): HTMLButtonElement {
  const node = element(parent, 'button', cls, text);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}

export function renderCost(parent: Node, cost: number | null): HTMLElement {
  const label = element(parent, 'span', 'openrouter-response-cost', formatCost(cost));
  label.title = costDescription(cost);
  return label;
}

interface ModelPickerOptions {
  compact?: boolean;
  controlsParent?: HTMLElement;
  onUnavailable?: () => void;
}

export class ModelPicker {
  readonly select: HTMLSelectElement;
  readonly search: HTMLInputElement;
  readonly freeOnly: HTMLInputElement;
  private refreshButton: HTMLButtonElement;
  private selection: string;
  private unsubscribe: () => void;
  private destroyed = false;
  private disabled = false;
  private refreshing = false;
  private priceHint: HTMLElement | undefined;

  constructor(parent: HTMLElement, private host: PluginHost, onChange?: (model: string) => void, private options: ModelPickerOptions = {}) {
    this.selection = host.settings.defaultModel;
    const wrapper = element(parent, 'div', 'openrouter-picker');
    const label = element(wrapper, 'label', 'openrouter-model-label', options.compact ? '' : 'Model');
    this.select = element(label, 'select', 'openrouter-model-select');
    this.select.setAttribute('aria-label', 'Model');
    const controls = options.controlsParent ?? wrapper;
    const filters = element(controls, 'div', 'openrouter-model-filter');
    this.search = element(filters, 'input', 'openrouter-model-search');
    this.search.type = 'search';
    this.search.placeholder = 'Search models…';
    this.search.setAttribute('aria-label', 'Search models');
    const freeLabel = element(filters, 'label', 'openrouter-free-models-label');
    this.freeOnly = element(freeLabel, 'input');
    this.freeOnly.type = 'checkbox';
    this.freeOnly.checked = host.settings.showFreeModelsOnly;
    freeLabel.append('Free inference only');
    this.refreshButton = button(filters, 'Refresh models', 'openrouter-refresh-button', () => { void this.refresh(); });
    if (options.compact) this.priceHint = element(controls, 'p', 'openrouter-privacy-hint openrouter-model-pricing');
    this.select.addEventListener('change', () => {
      this.selection = this.select.value;
      this.updatePrice();
      onChange?.(this.selection);
    });
    this.search.addEventListener('input', () => this.render());
    this.freeOnly.addEventListener('change', () => {
      host.settings.showFreeModelsOnly = this.freeOnly.checked;
      void host.saveSettings();
      this.render();
    });
    this.unsubscribe = host.subscribeModels(() => this.render());
    this.render();
  }

  get value(): string { return this.select.value; }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.refreshButton.disabled = true;
    this.refreshButton.textContent = 'Refreshing…';
    try { await this.host.refreshModels(); }
    finally {
      this.refreshing = false;
      if (!this.destroyed) {
        this.refreshButton.textContent = 'Refresh models';
        this.refreshButton.disabled = this.disabled;
      }
    }
  }

  render(): void {
    if (this.destroyed) return;
    const models = filterModels(this.host.settings.cachedModels, this.search.value, this.freeOnly.checked);
    this.select.replaceChildren();
    const placeholder = element(this.select, 'option', '', models.length ? 'Choose a model…' : 'No models available — refresh or change filters');
    placeholder.value = '';
    placeholder.disabled = true;
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const model of models) {
      let group = groups.get(model.provider);
      if (!group) {
        group = element(this.select, 'optgroup');
        group.label = model.provider;
        groups.set(model.provider, group);
      }
      const option = element(group, 'option', '', this.options.compact ? model.name : modelLabel(model));
      option.value = model.id;
    }
    // No implicit first option and no resetting to the default on each render.
    this.select.value = models.some(model => model.id === this.selection) ? this.selection : '';
    this.updatePrice();
    if (!this.select.value) this.options.onUnavailable?.();
  }

  private updatePrice(): void {
    const model = this.host.settings.cachedModels.find(item => item.id === this.select.value);
    this.select.title = model ? modelLabel(model) : 'Choose an available model';
    if (this.priceHint) this.priceHint.textContent = model
      ? `Catalog pricing: ${modelLabel(model)}. Actual cost depends on usage and host; reported after the response.`
      : 'Choose a model. Catalog rates are estimates; the response shows the reported request cost.';
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.select.disabled = disabled;
    this.search.disabled = disabled;
    this.freeOnly.disabled = disabled;
    this.refreshButton.disabled = disabled || this.refreshing;
  }

  destroy(): void { this.destroyed = true; this.unsubscribe(); }
}
