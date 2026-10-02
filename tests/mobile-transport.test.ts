import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { OpenRouterClient } from '../src/api';
import { Conversation } from '../src/conversation';
import OpenRouterPlugin from '../src/main';
import { createMobileFetch } from '../src/mobile-transport';
import { OpenRouterSettingTab } from '../src/settings-tab';
import { deferred, settings } from './helpers';
import { Platform, requestUrl, Setting } from './obsidian-mock';

const catalog = { data: [{ id: 'vendor/paid', name: 'Example', pricing: { prompt: '0.001', completion: '0.002' } }] };
const answer = { choices: [{ message: { content: 'Native reply' } }], usage: { completion_tokens: 5, cost: 0.000123 } };

function nativeResponse(data: unknown, status = 200): RequestUrlResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return {
    status, headers: { 'content-type': 'application/json' }, arrayBuffer: bytes.buffer,
    get json(): never { throw new Error('Do not use the host JSON getter.'); },
    get text(): never { throw new Error('Do not use the host text getter.'); }
  };
}

function nativeClient(send: (request: RequestUrlParam) => Promise<RequestUrlResponse>) {
  return new OpenRouterClient(() => 'dummy-key', createMobileFetch(send), false);
}

afterEach(() => {
  Platform.isMobileApp = false;
  requestUrl.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native mobile transport', () => {
  it('loads public models without browser fetch or credentials', async () => {
    const browserFetch = vi.fn().mockRejectedValue(new Error('WebView fetch unavailable'));
    vi.stubGlobal('fetch', browserFetch);
    const send = vi.fn(async () => nativeResponse(catalog));
    const models = await nativeClient(send).models();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('vendor/paid');
    expect(send).toHaveBeenCalledExactlyOnceWith({ url: 'https://openrouter.ai/api/v1/models', method: 'GET', throw: false });
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it('never forwards accidentally supplied credentials or a body to the catalog', async () => {
    const send = vi.fn(async () => nativeResponse(catalog));
    await createMobileFetch(send)('https://openrouter.ai/api/v1/models', {
      method: 'GET', headers: { Authorization: 'Bearer dummy-key' }, body: 'private note'
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({ url: 'https://openrouter.ai/api/v1/models', method: 'GET', throw: false });
  });

  it.each([
    ['https://attacker.invalid/models', 'GET'],
    ['https://openrouter.ai.attacker.invalid/api/v1/models', 'GET'],
    ['http://openrouter.ai/api/v1/models', 'GET'],
    ['https://openrouter.ai/api/v1/models?redirect=other', 'GET'],
    ['https://openrouter.ai/api/v1/models', 'POST'],
    ['https://openrouter.ai/api/v1/chat/completions', 'GET']
  ])('blocks unsupported destinations and methods before native networking: %s %s', async (url, method) => {
    const send = vi.fn();
    await expect(createMobileFetch(send)(url, { method })).rejects.toThrow('Unsupported');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses a single buffered completion and preserves privacy with sensitive=%s', async sensitiveNotes => {
    const send = vi.fn(async (_request: RequestUrlParam) => nativeResponse(answer));
    const config = { ...settings(), useStreaming: true, useWebSearch: true };
    const onText = vi.fn();
    const result = await nativeClient(send).complete({
      settings: config, model: config.defaultModel, messages: [{ role: 'user', content: 'note' }], sensitiveNotes, onText
    });
    expect(result.content).toBe('Native reply');
    expect(result.costUsd).toBe(0.000123);
    expect(result.firstTokenMs).toBeNull();
    expect(result.completionTokens).toBe(5);
    expect(config.useStreaming).toBe(true);
    expect(onText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    const request = send.mock.calls[0]![0];
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.throw).toBe(false);
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer dummy-key');
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ model: 'vendor/paid', stream: false, max_tokens: 4096, messages: [{ role: 'user', content: 'note' }] });
    if (sensitiveNotes) {
      expect(body.provider).toEqual({ zdr: true, data_collection: 'deny' });
      expect(body.plugins).toEqual([{ id: 'web', enabled: false }]);
      expect(new Headers(request.headers).get('X-OpenRouter-Cache')).toBe('false');
    } else {
      expect(body.provider).toBeUndefined();
      expect(body.plugins).toEqual([{ id: 'web' }]);
      expect(new Headers(request.headers).has('X-OpenRouter-Cache')).toBe(false);
    }
  });

  it.each([302, 401, 402, 404, 429, 503])('preserves HTTP %s without reading private error bodies or retrying', async status => {
    const response = nativeResponse({ error: 'dummy-key PRIVATE NOTE' }, status);
    Object.defineProperty(response, 'arrayBuffer', { get() { throw new Error('Error body must not be read'); } });
    const send = vi.fn(async () => response);
    const client = nativeClient(send);
    const failure = client.complete({ model: 'vendor/paid', settings: settings(), messages: [], sensitiveNotes: true });
    const expected = { 401: 'rejected the API key', 402: 'credits are insufficient', 429: 'rate limit' }[status];
    await expect(failure).rejects.toThrow(expected ?? `HTTP ${status}`);
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not retry a failed native request through browser networking', async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal('fetch', browserFetch);
    const send = vi.fn(async () => { throw new Error('dummy-key PRIVATE NOTE'); });
    await expect(nativeClient(send).complete({ model: 'vendor/paid', settings: settings(), messages: [] })).rejects.toThrow('Could not connect');
    expect(send).toHaveBeenCalledOnce();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it('rejects an already-cancelled request before the native bridge is called', async () => {
    const send = vi.fn();
    const signal = AbortSignal.abort();
    await expect(nativeClient(send).models(signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
  });

  it('times out promptly while the native bridge remains pending and discards its late reply', async () => {
    vi.useFakeTimers();
    const pending = deferred<RequestUrlResponse>();
    const send = vi.fn(() => pending.promise);
    const onText = vi.fn();
    const failure = nativeClient(send).complete({
      model: 'vendor/paid', settings: { ...settings(), requestTimeoutSeconds: 10 }, messages: [], onText
    });
    const assertion = expect(failure).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    pending.resolve(nativeResponse(answer));
    await Promise.resolve();
    expect(onText).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it('clearing a native request rejects late output and cannot resend its sensitive history', async () => {
    const pending = deferred<RequestUrlResponse>();
    const send = vi.fn<(request: RequestUrlParam) => Promise<RequestUrlResponse>>()
      .mockImplementationOnce(() => pending.promise).mockImplementation(async () => nativeResponse(answer));
    const conversation = new Conversation(nativeClient(send));
    const old = conversation.send('private old prompt', 'vendor/paid', settings(), { sensitiveNotes: true });
    const assertion = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    conversation.clear();
    await assertion;
    await conversation.send('new prompt', 'vendor/paid', settings());
    pending.resolve(nativeResponse({ choices: [{ message: { content: 'private old answer' } }] }));
    await Promise.resolve();
    await conversation.send('next prompt', 'vendor/paid', settings());
    expect(conversation.requiresSensitiveNotes).toBe(false);
    for (const [request] of send.mock.calls.slice(1)) expect(String(request.body)).not.toContain('private old');
  });

  it('applies response size limits to the buffered native result before parsing', async () => {
    const response = nativeResponse(answer);
    response.arrayBuffer = new Uint8Array(4_000_001).buffer;
    await expect(nativeClient(async () => response).complete({
      model: 'vendor/paid', settings: settings(), messages: []
    })).rejects.toThrow('size limit');
  });
});

describe('mobile plugin integration', () => {
  async function openPlugin(mobile: boolean) {
    Platform.isMobileApp = mobile;
    const app = {
      secretStorage: { getSecret: () => 'dummy-key', setSecret: vi.fn() },
      workspace: { detachLeavesOfType: vi.fn(), on: vi.fn() }
    } as unknown as App;
    const plugin = new OpenRouterPlugin(app, { id: 'openrouter' } as PluginManifest);
    vi.mocked(plugin.loadData).mockResolvedValue({ secretName: 'openrouter-api-key', useStreaming: true });
    await plugin.onload();
    return { plugin, app };
  }

  it('wires the native bridge into startup and populates the picker despite blocked WebView fetch', async () => {
    const browserFetch = vi.fn().mockRejectedValue(new Error('WebView blocked'));
    vi.stubGlobal('fetch', browserFetch);
    requestUrl.mockResolvedValue(nativeResponse(catalog));
    const { plugin, app } = await openPlugin(true);
    await plugin.refreshModels();
    expect(plugin.client.supportsStreaming).toBe(false);
    expect(plugin.settings.cachedModels[0]?.id).toBe('vendor/paid');
    const names = vi.spyOn(Setting.prototype, 'setName');
    const tab = new OpenRouterSettingTab(app, plugin);
    tab.display();
    expect(tab.containerEl.querySelector('option[value="vendor/paid"]')?.textContent).toContain('Example');
    expect(names).toHaveBeenCalledWith('Responses on mobile');
    expect(names).not.toHaveBeenCalledWith('Stream responses');
    expect(plugin.settings.useStreaming).toBe(true);
    expect(browserFetch).not.toHaveBeenCalled();
    expect(requestUrl).toHaveBeenCalledOnce();
    tab.hide(); plugin.onunload();
  });

  it('retains the desktop fetch transport and streaming preference', async () => {
    const browserFetch = vi.fn(async () => new Response(JSON.stringify(catalog)));
    vi.stubGlobal('fetch', browserFetch);
    const { plugin, app } = await openPlugin(false);
    await plugin.refreshModels();
    expect(plugin.client.supportsStreaming).toBe(true);
    const names = vi.spyOn(Setting.prototype, 'setName');
    const tab = new OpenRouterSettingTab(app, plugin);
    tab.display();
    expect(names).toHaveBeenCalledWith('Stream responses');
    expect(names).not.toHaveBeenCalledWith('Responses on mobile');
    expect(plugin.settings.useStreaming).toBe(true);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledOnce();
    tab.hide(); plugin.onunload();
  });

  it('unloading ignores a native catalog result arriving after the plugin has stopped', async () => {
    const pending = deferred<RequestUrlResponse>();
    requestUrl.mockImplementation(() => pending.promise);
    const { plugin } = await openPlugin(true);
    const refresh = plugin.refreshModels();
    plugin.onunload();
    pending.resolve(nativeResponse(catalog));
    expect(await refresh).toBe(false);
    expect(plugin.settings.cachedModels).toEqual([]);
    expect(plugin.saveData).toHaveBeenCalledOnce();
  });
});
