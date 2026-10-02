import { element } from './ui';

let nextDescriptionId = 0;

/** A local request choice; changing it does not silently change other views or settings. */
export class SensitiveNotesControl {
  private checkbox: HTMLInputElement;
  private description: HTMLElement;
  private active: boolean;
  private busy = false;
  private locked = false;
  private status: HTMLElement | undefined;

  constructor(parent: HTMLElement, enabled: boolean, onChange: () => void = () => undefined, descriptionParent?: HTMLElement) {
    this.active = enabled;
    const container = element(parent, 'div', 'openrouter-sensitive-notes');
    const label = element(container, 'label', 'openrouter-sensitive-label');
    this.checkbox = element(label, 'input');
    this.checkbox.type = 'checkbox';
    this.checkbox.checked = enabled;
    label.append(descriptionParent ? 'Sensitive notes' : 'Sensitive notes (require ZDR)');
    if (descriptionParent) this.status = element(container, 'span', 'openrouter-sensitive-status');
    this.description = element(descriptionParent ?? container, 'p', 'openrouter-privacy-hint');
    this.description.id = `openrouter-sensitive-description-${nextDescriptionId++}`;
    this.description.setAttribute('aria-live', 'polite');
    this.checkbox.setAttribute('aria-describedby', this.description.id);
    this.checkbox.addEventListener('change', () => {
      if (!this.busy && !this.locked) {
        this.active = this.checkbox.checked;
        onChange();
      }
      this.render();
    });
    this.render();
  }

  get enabled(): boolean { return this.active; }

  setState(busy: boolean, locked = false): void {
    this.busy = busy;
    this.locked = locked;
    if (locked) this.active = true;
    this.render();
  }

  private render(): void {
    this.checkbox.checked = this.active;
    this.checkbox.disabled = this.busy || this.locked;
    if (this.status) {
      this.status.textContent = this.locked ? 'ZDR on · Clear chat to turn off' : this.active ? 'ZDR required' : '';
      this.status.hidden = !this.active;
    }
    this.description.textContent = this.locked
      ? 'Clear chat before turning this off: follow-ups include sensitive history. Requests require ZDR and disable web search and response caching.'
      : this.active
        ? 'Requires ZDR hosts and denies data collection. Requests disable web search and response caching. Cost and availability may change.'
        : 'Optional protection for this request. Requires ZDR hosts, which may change cost and availability.';
    if (this.active) this.description.append(' Account logging and enforced plugins still apply.');
  }
}
