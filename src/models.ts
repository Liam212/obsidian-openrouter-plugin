import { isRecord, type Model } from './types';

function price(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseModel(value: unknown): Model | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256) return null;
  const pricing: Record<string, string> = Object.create(null) as Record<string, string>;
  if (isRecord(value.pricing)) {
    for (const [key, cost] of Object.entries(value.pricing)) {
      if (typeof cost === 'string') pricing[key] = cost;
    }
  }
  // Router prices can be placeholders. Only OpenRouter's explicit free router qualifies.
  const dynamicRouter = value.id.startsWith('openrouter/') && value.id !== 'openrouter/free';
  const isFree = !dynamicRouter && price(pricing.prompt) === 0 && price(pricing.completion) === 0
    && Object.values(pricing).every(cost => price(cost) === 0);
  const provider = value.id.split('/')[0] || 'Other';
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.slice(0, 256) : value.id,
    provider: provider.charAt(0).toUpperCase() + provider.slice(1),
    pricing,
    isFree
  };
}

export function parseModels(payload: unknown): Model[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error('OpenRouter returned an invalid model list.');
  const models = new Map<string, Model>();
  for (const value of payload.data) {
    const model = parseModel(value);
    if (model) models.set(model.id, model);
  }
  if (!models.size) throw new Error('OpenRouter returned no usable models.');
  return [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

export function filterModels(models: Model[], search = '', freeOnly = false): Model[] {
  const needle = search.trim().toLowerCase();
  return models.filter(model => (!freeOnly || model.isFree)
    && [model.name, model.id, model.provider].some(text => text.toLowerCase().includes(needle)));
}

export function modelLabel(model: Model): string {
  if (model.isFree) return `${model.name} — Free inference`;
  const prompt = price(model.pricing.prompt);
  const completion = price(model.pricing.completion);
  if (prompt === null || completion === null || (prompt === 0 && completion === 0)) {
    return `${model.name} — Pricing varies or is unavailable`;
  }
  return `${model.name} — $${(prompt * 1e6).toLocaleString('en-US')}/$${(completion * 1e6).toLocaleString('en-US')} per 1M input/output tokens`;
}
