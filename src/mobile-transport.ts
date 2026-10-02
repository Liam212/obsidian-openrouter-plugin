import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

type NativeRequest = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/** Obsidian's native mobile HTTP bridge avoids WebView fetch/CORS restrictions.
 * It buffers replies and exposes no AbortSignal or redirect/cookie controls.
 * OpenRouterClient owns the deadline and rejects late replies after cancellation.
 */
export function createMobileFetch(request: NativeRequest = requestUrl): typeof fetch {
  return async (input, init) => {
    // Do not turn this bridge into a general proxy or accept model-supplied URLs.
    const catalog = input === 'https://openrouter.ai/api/v1/models' && init?.method === 'GET';
    const completion = input === 'https://openrouter.ai/api/v1/chat/completions' && init?.method === 'POST';
    if (!catalog && !completion) throw new Error('Unsupported OpenRouter request.');
    if (init?.body != null && typeof init.body !== 'string') throw new Error('Unsupported request body.');
    init?.signal?.throwIfAborted();
    const response = await request({
      url: input as string,
      method: init?.method,
      // Catalog requests never need credentials, even if passed by mistake.
      ...(completion ? {
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body as string | undefined
      } : {}),
      throw: false
    });
    init?.signal?.throwIfAborted();
    // Preserve HTTP failures for the client's safe status messages. Do not read
    // provider error bodies or depend on requestUrl's eagerly parsed json getter.
    const successful = response.status >= 200 && response.status < 300;
    const empty = response.status === 204 || response.status === 205;
    return new Response(successful && !empty ? response.arrayBuffer : null, { status: response.status });
  };
}
