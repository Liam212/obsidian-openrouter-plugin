import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, readCompletionStream } from '../src/api';
import { deferred, jsonResponse, settings, streamResponse } from './helpers';

afterEach(() => vi.useRealTimers());

describe('API boundaries', () => {
  it('sends only to the fixed endpoint, uses the requested stream mode and caps output', async () => {
    const fetcher = vi.fn(async () => jsonResponse());
    const client = new OpenRouterClient(() => 'dummy-key', fetcher);
    const result = await client.complete({ model: 'vendor/paid', settings: settings(), messages: [{ role: 'user', content: 'test' }] });
    const [url, options] = vi.mocked(fetcher as typeof fetch).mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(options?.body))).toMatchObject({ stream: false, max_tokens: 4096, model: 'vendor/paid' });
    expect(result.firstTokenMs).toBeNull();
    expect(result.completionTokens).toBe(5);
  });
  it('loads public models without sending a key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'v/model' }] })));
    await new OpenRouterClient(() => 'dummy-key', fetcher).models();
    expect(vi.mocked(fetcher as typeof fetch).mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
  it('rejects missing/retired models, missing keys and unsafe free-only requests before networking', async () => {
    const fetcher = vi.fn();
    const client = new OpenRouterClient(() => 'dummy', fetcher);
    const request = { model: '', settings: settings(), messages: [] };
    await expect(client.complete(request)).rejects.toThrow('Choose');
    await expect(client.complete({ ...request, model: 'retired/model' })).rejects.toThrow('Choose');
    request.model = 'vendor/paid';
    await expect(new OpenRouterClient(() => null, fetcher).complete(request)).rejects.toThrow('API key');
    request.settings.showFreeModelsOnly = true;
    await expect(client.complete(request)).rejects.toThrow('verified free');
    request.model = 'vendor/free:free'; request.settings.useWebSearch = true;
    await expect(client.complete(request)).rejects.toThrow('Web search');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses explicit opt-in web search without rewriting the model identifier', async () => {
    const fetcher = vi.fn(async () => jsonResponse());
    const config = settings(); config.useWebSearch = true;
    await new OpenRouterClient(() => 'dummy', fetcher).complete({ model: config.defaultModel, settings: config, messages: [] });
    expect(JSON.parse(String(vi.mocked(fetcher as typeof fetch).mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'vendor/paid', plugins: [{ id: 'web' }] });
  });
  it('does not surface sensitive provider error bodies', async () => {
    const client = new OpenRouterClient(() => 'dummy-key', async () => new Response('dummy-key PRIVATE_PROMPT', { status: 401 }));
    await expect(client.complete({ model: 'vendor/paid', settings: settings(), messages: [] })).rejects.toThrow('rejected the API key');
  });
  it.each([
    'not json', JSON.stringify({ error: { message: 'private error' } }),
    JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: null } }] })
  ])('rejects malformed and unsuccessful responses without treating them as answers', async body => {
    const client = new OpenRouterClient(() => 'dummy', async () => new Response(body));
    await expect(client.complete({ model: 'vendor/paid', settings: settings(), messages: [] })).rejects.toThrow();
  });
  it('times out and aborts a hanging request even if fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetcher = vi.fn(() => pending.promise);
    const client = new OpenRouterClient(() => 'dummy', fetcher);
    const config = settings(); config.requestTimeoutSeconds = 10;
    const result = client.complete({ model: 'vendor/paid', settings: config, messages: [] });
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(vi.mocked(fetcher as typeof fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(jsonResponse('late reply'));
  });
  it('unload aborts all requests and blocks new requests', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const client = new OpenRouterClient(() => 'dummy', fetcher);
    const request = client.models();
    const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    client.dispose();
    await assertion;
    expect(vi.mocked(fetcher as typeof fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(client.models()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('honours a signal that was already cancelled', async () => {
    const fetcher = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(new OpenRouterClient(() => 'dummy', fetcher).models(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('times out during body consumption, not just before response headers', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const client = new OpenRouterClient(() => 'dummy', async () => new Response(new ReadableStream({ cancel })));
    const config = settings(); config.requestTimeoutSeconds = 10;
    const result = client.complete({ model: 'vendor/paid', settings: config, messages: [] });
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
});

describe('streaming', () => {
  it('handles byte-split JSON, UTF-8, CRLF, comments and usage-only events', async () => {
    const text = ': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"Hello 🌍"}}]}\r\n\r\ndata: {"choices":[],"usage":{"completion_tokens":2}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const updates: string[] = [];
    const result = await readCompletionStream(streamResponse(text), new AbortController().signal, value => updates.push(value));
    expect(result.content).toBe('Hello 🌍');
    expect(result.completionTokens).toBe(2);
    expect(updates).toEqual(['Hello 🌍']);
  });
  it('handles multiple events per chunk, multiline data and a final DONE without a newline', async () => {
    const text = 'data: {"choices":\ndata: [{"delta":{"content":"first"}}]}\n\ndata: {"choices":[{"delta":{"content":" second"}}]}\n\ndata: [DONE]';
    const result = await readCompletionStream(streamResponse(text, 10000), new AbortController().signal, () => undefined);
    expect(result.content).toBe('first second');
  });
  it.each([
    'data: {"error":{"message":"sensitive"}}\n\n',
    'data: {broken}\n\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n',
    'data: [DONE]\n\n'
  ])('rejects errors, malformed events, truncation and empty answers', async text => {
    await expect(readCompletionStream(streamResponse(text, 10000), new AbortController().signal, () => undefined)).rejects.toThrow();
  });
  it('bounds unterminated SSE data', async () => {
    await expect(readCompletionStream(streamResponse('data: ' + 'x'.repeat(256001), 300000), new AbortController().signal, () => undefined)).rejects.toThrow('size limit');
  });
  it('actually streams when enabled and cancels reading after DONE', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n')); }, cancel
    })));
    const config = settings(); config.useStreaming = true;
    const onText = vi.fn();
    const result = await new OpenRouterClient(() => 'dummy', fetcher).complete({ model: 'vendor/paid', settings: config, messages: [], onText });
    expect(JSON.parse(String(vi.mocked(fetcher as typeof fetch).mock.calls[0]?.[1]?.body)).stream).toBe(true);
    expect(result.content).toBe('streamed');
    expect(onText).toHaveBeenCalledWith('streamed');
    expect(cancel).toHaveBeenCalled();
  });
});
