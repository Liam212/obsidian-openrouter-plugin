import { describe, expect, it } from 'vitest';
import { filterModels, parseModel, parseModels } from '../src/models';
import { ModelPicker } from '../src/ui';
import { host } from './helpers';

describe('pricing', () => {
  it('ignores free claims in names/descriptions and uses prices', () => {
    const paid = parseModel({ id: 'v/paid', name: 'Free expression', description: 'free', pricing: { prompt: '0.1', completion: '0.1' } })!;
    const free = parseModel({ id: 'v/zero', name: 'Zero cost', pricing: { prompt: '0', completion: '0' } })!;
    expect(paid.isFree).toBe(false);
    expect(filterModels([paid, free], '', true)).toEqual([free]);
  });
  it.each([
    { id: 'v/unknown' },
    { id: 'v/negative', pricing: { prompt: '-1', completion: '0' } },
    { id: 'v/invalid', pricing: { prompt: '', completion: '0' } },
    { id: 'v/request', pricing: { prompt: '0', completion: '0', request: '0.01' } },
    { id: 'openrouter/auto', pricing: { prompt: '0', completion: '0' } }
  ])('does not call uncertain/dynamic/charged pricing free: $id', model => {
    expect(parseModel(model)?.isFree).toBe(false);
  });
  it('rejects invalid catalogs and skips malformed entries', () => {
    expect(() => parseModels({ data: [null, { id: 3 }] })).toThrow();
    expect(parseModels({ data: [null, { id: 'v/one' }, { id: 'v/one' }] })).toHaveLength(1);
  });
});

describe('model selection', () => {
  it('never implicitly selects the first model when the default is unavailable', () => {
    const plugin = host(); plugin.settings.defaultModel = 'retired/model';
    const picker = new ModelPicker(document.createElement('div'), plugin);
    expect(picker.value).toBe('');
    picker.destroy();
  });
  it('preserves an explicit selection across refresh, search and filter changes', () => {
    const plugin = host();
    const picker = new ModelPicker(document.createElement('div'), plugin);
    picker.select.value = 'vendor/free:free';
    picker.select.dispatchEvent(new Event('change'));
    plugin.publish();
    expect(picker.value).toBe('vendor/free:free');
    picker.search.value = 'Paid'; picker.search.dispatchEvent(new Event('input'));
    expect(picker.value).toBe('');
    picker.search.value = ''; picker.search.dispatchEvent(new Event('input'));
    expect(picker.value).toBe('vendor/free:free');
    picker.freeOnly.checked = true; picker.freeOnly.dispatchEvent(new Event('change'));
    expect(picker.value).toBe('vendor/free:free');
    picker.destroy();
  });
  it('clears a disappeared selection without choosing a replacement', () => {
    const plugin = host();
    const picker = new ModelPicker(document.createElement('div'), plugin);
    plugin.settings.cachedModels = plugin.settings.cachedModels.filter(model => model.isFree);
    plugin.publish();
    expect(picker.value).toBe('');
    picker.destroy();
  });
});
