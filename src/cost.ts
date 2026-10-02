import { isRecord } from './types';

/** OpenRouter's account charge, in USD; never infer a charge from catalog rates. */
export function reportedCost(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  return typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
}

export function formatCost(cost: number | null): string {
  if (cost === null) return 'Cost not reported';
  if (cost > 0 && cost < 0.000001) return 'Cost: < $0.000001 USD';
  return `Cost: $${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USD`;
}

export function costDescription(cost: number | null): string {
  return cost === null
    ? 'OpenRouter did not report a valid cost. This does not mean the request was free.'
    : `Reported by OpenRouter: ${cost} USD. Separate charges from your own provider account are not included.`;
}
