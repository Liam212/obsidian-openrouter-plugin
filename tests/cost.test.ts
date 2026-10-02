import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { OpenRouterClient, readCompletionStream } from '../src/api';
import { ChatView } from '../src/chat-view';
import { formatCost, reportedCost } from '../src/cost';
import { PromptModal } from '../src/prompt-modal';
import { deferred, host, settings, streamResponse } from './helpers';

function response(usage: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' } }], usage }));
}
afterEach(() => document.body.replaceChildren());
const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const answer = chunk({ choices: [{ delta: { content: 'Answer' } }] });

async function complete(usage: unknown) {
  const fetcher = vi.fn<typeof fetch>(async () => response(usage));
  const client = new OpenRouterClient(() => 'test-key', fetcher);
  const result = await client.complete({ settings: settings(), model: 'vendor/paid', messages: [{ role: 'user', content: 'Hello' }] });
  expect(fetcher).toHaveBeenCalledOnce(); // No extra billing lookup or model request.
  return result;
}

describe('reported request cost', () => {
  it.each([0, 0.000000023, 0.001234, 1.25])('reads numeric cost %s without estimating from tokens', async cost => {
    expect((await complete({ cost, completion_tokens: 900, cost_details: { upstream_inference_cost: 12 } })).costUsd).toBe(cost);
  });
  it.each([undefined, null, {}, [], { cost: null }, { cost: '0.12' }, { cost: -1 }, { cost_details: { upstream_inference_cost: 12 } }])('does not infer a charge from invalid or missing usage %j', async usage => {
    expect((await complete(usage)).costUsd).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity])('rejects non-finite costs %s', cost => {
    expect(reportedCost({ cost })).toBeNull();
  });
  it('shows small charges without rounding them to free', () => {
    expect(formatCost(0)).toBe('Cost: $0.00 USD');
    expect(formatCost(0.000001)).toBe('Cost: $0.000001 USD');
    expect(formatCost(0.000000023)).toBe('Cost: < $0.000001 USD');
    expect(formatCost(0.001234)).toBe('Cost: $0.001234 USD');
    expect(formatCost(null)).toBe('Cost not reported');
  });
  it.each([0, 0.005])('uses the final streaming usage total %s without adding cumulative updates', async cost => {
    const stream = answer + chunk({ usage: { cost: 0.003 } }) + chunk({ choices: [], usage: { cost } })
      + chunk({ choices: [], usage: { completion_tokens: 5 } }) + 'data: [DONE]\n\n';
    const result = await readCompletionStream(streamResponse(stream), new AbortController().signal, vi.fn());
    expect(result).toMatchObject({ content: 'Answer', costUsd: cost, completionTokens: 5 });
  });
  it('keeps a completed stream without usage distinct from zero cost', async () => {
    const result = await readCompletionStream(streamResponse(answer + 'data: [DONE]\n\n'), new AbortController().signal, vi.fn());
    expect(result.costUsd).toBeNull();
  });
  it('rejects a truncated stream even if it already reported cost', async () => {
    await expect(readCompletionStream(streamResponse(answer + chunk({ usage: { cost: 0.02 } })), new AbortController().signal, vi.fn())).rejects.toThrow('before completion');
  });
});

describe('cost display and compact chat', () => {
  async function chat(fetcher: typeof fetch) {
    const plugin = host(fetcher);
    const view = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    await view.onOpen();
    document.body.append(view.contentEl);
    return { view, plugin, input: view.contentEl.querySelector('textarea')! };
  }
  it('shows each response cost, preserves full precision in metrics, and does not display catalog rates as charges', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => response({ cost: 0.000000023 })).mockImplementationOnce(async () => response({}));
    const { view, input } = await chat(fetcher);
    expect(view.contentEl.querySelector('.openrouter-response-cost')).toBeNull();
    input.value = 'First'; await view.send();
    expect(view.contentEl.querySelector('.openrouter-response-cost')?.textContent).toBe('Cost: < $0.000001 USD');
    expect(view.contentEl.querySelector('.openrouter-response-metrics')?.textContent).toContain('Reported by OpenRouter: 2.3e-8 USD');
    input.value = 'Second'; await view.send();
    expect([...view.contentEl.querySelectorAll('.openrouter-response-cost')].map(el => el.textContent)).toEqual(['Cost: < $0.000001 USD', 'Cost not reported']);
    view.clear();
    expect(view.contentEl.querySelector('.openrouter-response-cost')).toBeNull();
    await view.onClose();
  });
  it('discards costs from a late cancelled response and restores the Send action', async () => {
    const pending = deferred<Response>();
    const { view, input } = await chat(() => pending.promise);
    const stop = view.contentEl.querySelector<HTMLButtonElement>('.openrouter-stop-button')!;
    const send = view.contentEl.querySelector<HTMLButtonElement>('.openrouter-send-button')!;
    expect(stop.hidden).toBe(true);
    input.value = 'Question'; const request = view.send();
    expect(stop.hidden).toBe(false); expect(send.hidden).toBe(true);
    stop.click(); pending.resolve(response({ cost: 0.5 })); await request;
    expect(view.contentEl.querySelector('.openrouter-response-cost')).toBeNull();
    expect(stop.hidden).toBe(true); expect(send.hidden).toBe(false);
    await view.onClose();
  });
  it('keeps filters accessible, opens options for an unavailable model, and keeps protected history visible', async () => {
    const { view, plugin, input } = await chat(async () => response({ cost: 0 }));
    const options = view.contentEl.querySelector<HTMLElement>('.openrouter-chat-options')!;
    const toggle = view.contentEl.querySelector<HTMLButtonElement>('.openrouter-options-button')!;
    expect(options.hidden).toBe(true);
    toggle.click(); expect(options.hidden).toBe(false); expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(options.querySelector('.openrouter-model-search')).not.toBeNull();
    expect(options.querySelector('.openrouter-model-pricing')?.textContent).toContain('Catalog pricing');
    toggle.click();
    const privacy = view.contentEl.querySelector<HTMLInputElement>('.openrouter-sensitive-label input')!;
    expect(options.contains(privacy)).toBe(false);
    privacy.click(); input.value = 'Sensitive question'; await view.send();
    expect(options.hidden).toBe(true); expect(privacy.disabled).toBe(true);
    expect(view.contentEl.querySelector('.openrouter-sensitive-status')?.textContent).toContain('Clear chat to turn off');
    plugin.settings.cachedModels = []; plugin.publish();
    expect(options.hidden).toBe(false);
    expect(view.contentEl.querySelector('select')?.value).toBe('');
    await view.onClose();
  });
  it('opens options on first setup without automatically choosing a model', async () => {
    const plugin = host(); plugin.settings.defaultModel = '';
    const view = new ChatView({ app: {} } as unknown as WorkspaceLeaf, plugin);
    await view.onOpen();
    document.body.append(view.contentEl);
    expect(view.contentEl.querySelector<HTMLElement>('.openrouter-chat-options')?.hidden).toBe(false);
    expect(view.contentEl.querySelector('select')?.value).toBe('');
    await view.onClose();
  });
  it('clears prompt costs when regenerating, failing or changing privacy', async () => {
    const next = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => response({ cost: 0.01 }))
      .mockImplementationOnce(() => next.promise).mockImplementation(async () => response({ cost: 0 }));
    const modal = new PromptModal({} as App, host(fetcher), 'Question', vi.fn());
    modal.onOpen(); document.body.append(modal.contentEl); await modal.generate();
    expect(modal.contentEl.querySelector('.openrouter-response-cost')?.textContent).toBe('Cost: $0.01 USD');
    const second = modal.generate();
    expect(modal.contentEl.querySelector('.openrouter-response-cost')).toBeNull();
    next.reject(new Error('offline')); await second;
    expect(modal.contentEl.querySelector('.openrouter-response-cost')).toBeNull();
    await modal.generate();
    expect(modal.contentEl.querySelector('.openrouter-response-cost')?.textContent).toBe('Cost: $0.00 USD');
    modal.contentEl.querySelector<HTMLInputElement>('.openrouter-sensitive-label input')!.click();
    expect(modal.contentEl.querySelector('.openrouter-response-cost')).toBeNull();
    modal.onClose();
  });
});
