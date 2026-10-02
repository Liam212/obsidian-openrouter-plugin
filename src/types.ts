export interface Model {
  id: string;
  name: string;
  provider: string;
  pricing: Record<string, string>;
  isFree: boolean;
}

export interface Settings {
  secretName: string;
  defaultModel: string;
  systemMessage: string;
  cachedModels: Model[];
  lastModelUpdate: number;
  showFreeModelsOnly: boolean;
  useWebSearch: boolean;
  useStreaming: boolean;
  sensitiveNotesByDefault: boolean;
  requestTimeoutSeconds: number;
  maxOutputTokens: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  content: string;
  totalMs: number;
  firstTokenMs: number | null;
  completionTokens: number | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
