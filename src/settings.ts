import { parseModel } from './models';
import { isRecord, type Settings } from './types';

export interface Secrets {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export function readSettings(raw: unknown): Settings {
  const data = isRecord(raw) ? raw : {};
  const integer = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  const cachedModels = Array.isArray(data.cachedModels)
    ? data.cachedModels.map(parseModel).filter(model => model !== null) : [];
  return {
    secretName: typeof data.secretName === 'string' && /^[a-z0-9-]+$/.test(data.secretName) ? data.secretName : '',
    defaultModel: typeof data.defaultModel === 'string' ? data.defaultModel : '',
    systemMessage: typeof data.systemMessage === 'string' ? data.systemMessage : 'You are a helpful assistant.',
    cachedModels,
    // Old caches lack pricing; force a refresh rather than trusting their free flags.
    lastModelUpdate: cachedModels.every(model => 'prompt' in model.pricing)
      ? integer(data.lastModelUpdate, 0, 0, Date.now()) : 0,
    showFreeModelsOnly: data.showFreeModelsOnly === true,
    useWebSearch: data.useWebSearch === true,
    useStreaming: typeof data.useStreaming === 'boolean' ? data.useStreaming : true,
    requestTimeoutSeconds: integer(data.requestTimeoutSeconds, 120, 10, 600),
    maxOutputTokens: integer(data.maxOutputTokens, 4096, 64, 32768)
  };
}

/** Persist only this whitelist: never spread raw legacy settings into a save. */
export async function migrateSettings(raw: unknown, secrets: Secrets, save: (settings: Settings) => Promise<void>): Promise<Settings> {
  const settings = readSettings(raw);
  const legacyKey = isRecord(raw) && typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (legacyKey && !(settings.secretName && secrets.getSecret(settings.secretName))) {
    const base = 'openrouter-api-key';
    let name = base;
    for (let suffix = 2; secrets.getSecret(name) && secrets.getSecret(name) !== legacyKey; suffix++) {
      name = `${base}-${suffix}`;
    }
    secrets.setSecret(name, legacyKey);
    if (secrets.getSecret(name) !== legacyKey) throw new Error('Could not migrate the OpenRouter credential.');
    settings.secretName = name;
  }
  // Save only after successful secret storage. On failure, leave the original file recoverable.
  await save(settings);
  return settings;
}
