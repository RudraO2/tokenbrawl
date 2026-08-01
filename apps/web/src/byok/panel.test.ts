import { describe, expect, it } from 'vitest';
import type { CommandLog } from '@tokenbrawl/contracts';
import { createFakeTransport, chatCompletionBody } from '../testing/byok-transport';
import { byokCatalogue } from './catalogue';
import { ByokKeyError } from './client';
import type { KeyStorage } from './keys';
import { byokMarkup, mountByokPanel, type ByokHost, type ByokNode } from './panel';
import { runByokMatch, type ByokRunConfig } from './run';

/**
 * Story 4.6's surface, driven without a DOM.
 *
 * Same discipline as `startup.test.ts`: structural fakes under Vitest's default
 * `node` environment, so `apps/web` stays at `vite` plus `vitest` and every
 * branch of the panel is reachable from a test rather than from a browser.
 */

interface FakePanelHost extends ByokHost {
  readonly node: (selector: string) => ByokNode;
  readonly fire: (selector: string, type: string) => void;
  readonly html: () => string;
}

function createHost(): FakePanelHost {
  const nodes = new Map<string, ByokNode>();
  const listeners = new Map<string, (() => void)[]>();
  const state = { html: '' };

  const child = (selector: string): ByokNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: ByokNode = {
      innerHTML: '',
      value: '',
      checked: false,
      disabled: false,
      setAttribute: (): void => undefined,
      addEventListener: (type, listener): void => {
        const key = `${selector}:${type}`;
        listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      },
    };
    nodes.set(selector, node);
    return node;
  };

  return {
    get innerHTML(): string {
      return state.html;
    },
    set innerHTML(value: string) {
      state.html = value;
    },
    querySelector: (selector: string): ByokNode | null => child(selector),
    node: child,
    html: () => state.html,
    fire: (selector: string, type: string): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener();
      }
    },
  };
}

function createFakeStorage(): KeyStorage & { readonly size: () => number } {
  const entries = new Map<string, string>();
  return {
    size: () => entries.size,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/** A panel wired to a real Match over a fake transport, which is the whole path bar the network. */
function mountWithTransport(overrides: { readonly storage?: KeyStorage } = {}) {
  const host = createHost();
  const transport = createFakeTransport({
    body: (call) => chatCompletionBody(call % 2 === 0 ? 'ACTION: advance' : 'ACTION: block'),
  });
  const logs: CommandLog[] = [];
  const panel = mountByokPanel(host, {
    storage: overrides.storage,
    onLog: (log) => logs.push(log),
    run: (config: ByokRunConfig) => runByokMatch({ ...config, fetch: transport.fetch }),
  });
  host.node('[data-key="0"]').value = 'gsk_p1_key_do_not_use_000001';
  host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';
  return { host, panel, logs, transport };
}

describe('the picker shows what can run here, and what cannot (AC5)', () => {
  it('lists every CLI-only provider, labelled and disabled', () => {
    const markup = byokMarkup(byokCatalogue());
    expect(markup).toContain('OpenRouter — CLI ONLY');
    expect(markup).toContain('xAI — CLI ONLY');
    // Disabled, not absent. A hidden provider tells a visitor nothing.
    expect(markup).toMatch(/<option value="openrouter" disabled>/);
    expect(markup).toMatch(/<option value="xai" disabled>/);
  });

  it('leaves the browser-capable providers selectable', () => {
    const markup = byokMarkup(byokCatalogue());
    expect(markup).toMatch(/<option value="groq">/);
    expect(markup).toMatch(/<option value="cerebras">/);
    expect(markup).toMatch(/<option value="google-ai-studio">/);
  });

  it('offers a model list for the provider that is selected first', () => {
    const { host } = mountWithTransport();
    expect(host.node('[data-model="0"]').innerHTML).toContain('llama-3.1-8b-instant');
    expect(host.node('[data-provider="0"]').value).toBe('groq');
  });

  it('repopulates the models when the provider changes', () => {
    const { host } = mountWithTransport();
    host.node('[data-provider="1"]').value = 'google-ai-studio';
    host.fire('[data-provider="1"]', 'change');
    expect(host.node('[data-model="1"]').innerHTML).toContain('gemini-2.5-flash');
    expect(host.node('[data-model="1"]').innerHTML).not.toContain('llama-3.1-8b-instant');
    expect(host.node('[data-model="1"]').value).toBe('gemini-2.5-flash');
  });

  it('offers no model, and refuses to run, if a CLI-only provider is forced in', async () => {
    // Reachable only by ignoring `disabled` -- an autofill, or a browser that
    // does not honour it. The run must still refuse before any request.
    const { host, panel, transport, logs } = mountWithTransport();
    host.node('[data-provider="0"]').value = 'openrouter';
    host.fire('[data-provider="0"]', 'change');
    expect(host.node('[data-model="0"]').innerHTML).toBe('');

    await panel.submit();
    expect(panel.state()).toBe('failed');
    expect(transport.calls()).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});

describe('running a fight from the panel (AC3, AC4)', () => {
  it('hands the completed log to its caller and says so', async () => {
    const { panel, logs } = mountWithTransport();
    await panel.submit();
    expect(panel.state()).toBe('done');
    expect(logs).toHaveLength(1);
    expect(logs[0].agents.map((agent) => agent.deployment?.provider)).toStrictEqual(['byok', 'byok']);
  });

  it('reports progress without any notion of duration (INV-3)', async () => {
    const { host, panel } = mountWithTransport();
    await panel.submit();
    const progress = host.node('[data-progress]').innerHTML;
    expect(progress).toMatch(/^\d+ calls made$/);
    // No seconds, no percentage, no estimate. Anything of the sort would leak
    // how long a Deployment took to think.
    expect(progress).not.toMatch(/second|ms\b|%|remaining|elapsed/i);
  });

  it('keeps the live region for state changes only, never for progress', async () => {
    // Story 4.5's constraint, inherited: a live region rewritten on a fast loop
    // is worse for a screen-reader user than silence.
    const { host, panel } = mountWithTransport();
    await panel.submit();
    expect(host.node('[data-status]').innerHTML).not.toMatch(/calls made/);
    expect(host.node('[data-status]').innerHTML).toMatch(/excluded from every rating/i);
  });

  it('names the fighter whose key failed, and produces no log (AC3)', async () => {
    const host = createHost();
    const logs: CommandLog[] = [];
    const transport = createFakeTransport({ statuses: [401], body: () => 'Invalid API Key' });
    const panel = mountByokPanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runByokMatch({ ...config, fetch: transport.fetch }),
    });
    host.node('[data-key="0"]').value = 'gsk_p1_key_do_not_use_000001';
    host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';

    await panel.submit();
    expect(panel.state()).toBe('failed');
    expect(host.node('[data-status]').innerHTML).toMatch(/Fighter [12]/);
    expect(logs).toHaveLength(0);
  });

  it('never puts a key on the page, even when the provider quoted it back', async () => {
    const key = 'gsk_p1_key_do_not_use_000001';
    const host = createHost();
    const transport = createFakeTransport({
      statuses: [401],
      body: () => `Incorrect API key provided: ${key}`,
    });
    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: (config) => runByokMatch({ ...config, fetch: transport.fetch }),
    });
    host.node('[data-key="0"]').value = key;
    host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';

    await panel.submit();
    expect(host.node('[data-status]').innerHTML).not.toContain(key);
    expect(host.html()).not.toContain(key);
  });

  it('reports a failure that is not a key problem rather than swallowing it', async () => {
    const host = createHost();
    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: () => Promise.reject(new Error('the environment refused to start')),
    });
    host.node('[data-key="0"]').value = 'gsk_p1_key_do_not_use_000001';
    host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';
    await panel.submit();
    expect(panel.state()).toBe('failed');
    expect(host.node('[data-status]').innerHTML).toContain('the environment refused to start');
  });

  it('disables the run button while a Match is in flight, and restores it after', async () => {
    const { host, panel } = mountWithTransport();
    const inFlight = panel.submit();
    expect(host.node('[data-run]').disabled).toBe(true);
    await inFlight;
    expect(host.node('[data-run]').disabled).toBe(false);
  });

  it('ignores a second run while the first is still going', async () => {
    // Two Matches in flight on one key is the fastest way to a rate limit, and
    // the second log would replace the first with no explanation.
    const { panel, logs } = mountWithTransport();
    const first = panel.submit();
    await panel.submit();
    await first;
    expect(logs).toHaveLength(1);
  });

  it('trims a pasted key, because a trailing newline is what a paste carries', async () => {
    const { host, panel, transport } = mountWithTransport();
    host.node('[data-key="0"]').value = '  gsk_p1_key_do_not_use_000001\n';
    await panel.submit();
    expect(panel.state()).toBe('done');
    expect(transport.calls()[0].headers.Authorization).toBe('Bearer gsk_p1_key_do_not_use_000001');
  });
});

describe('keys are stored only on an explicit opt-in (AC2)', () => {
  it('writes nothing after a successful Match when the box is unticked', async () => {
    const storage = createFakeStorage();
    const { panel } = mountWithTransport({ storage });
    await panel.submit();
    expect(panel.state()).toBe('done');
    expect(storage.size()).toBe(0);
  });

  it('writes both keys when the box is ticked, and reads them back next time', async () => {
    const storage = createFakeStorage();
    const { host, panel } = mountWithTransport({ storage });
    host.node('[data-remember]').checked = true;
    await panel.submit();
    expect(storage.size()).toBe(1);

    const second = createHost();
    mountByokPanel(second, { storage, onLog: (): void => undefined });
    expect(second.node('[data-key="0"]').value).toBe('gsk_p1_key_do_not_use_000001');
    expect(second.node('[data-key="1"]').value).toBe('gsk_p2_key_do_not_use_000002');
    expect(second.node('[data-remember]').checked).toBe(true);
  });

  it('forgets immediately when the box is unticked, not at the next run', async () => {
    const storage = createFakeStorage();
    const { host, panel } = mountWithTransport({ storage });
    host.node('[data-remember]').checked = true;
    await panel.submit();
    expect(storage.size()).toBe(1);

    host.node('[data-remember]').checked = false;
    host.fire('[data-remember]', 'change');
    expect(storage.size()).toBe(0);
  });

  it('writes nothing when a Match failed, even with the box ticked', async () => {
    // A key that the provider just rejected is the last thing worth keeping.
    const storage = createFakeStorage();
    const host = createHost();
    const transport = createFakeTransport({ statuses: [401], body: () => 'Invalid API Key' });
    const panel = mountByokPanel(host, {
      storage,
      onLog: (): void => undefined,
      run: (config) => runByokMatch({ ...config, fetch: transport.fetch }),
    });
    host.node('[data-key="0"]').value = 'gsk_p1_key_do_not_use_000001';
    host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';
    host.node('[data-remember]').checked = true;

    await panel.submit();
    expect(panel.state()).toBe('failed');
    expect(storage.size()).toBe(0);
  });

  it('runs with no storage at all, which is a tab with storage blocked', async () => {
    const { panel, logs } = mountWithTransport();
    await panel.submit();
    expect(logs).toHaveLength(1);
  });
});

describe('the panel refuses what would fail at request time', () => {
  it('rejects a blank key without contacting anyone', async () => {
    const host = createHost();
    const transport = createFakeTransport();
    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: (config) => runByokMatch({ ...config, fetch: transport.fetch }),
    });
    await panel.submit();
    expect(panel.state()).toBe('failed');
    expect(transport.calls()).toHaveLength(0);
  });

  it('rejects a seed outside the range the frozen schema can carry', async () => {
    const { host, panel, transport } = mountWithTransport();
    host.node('[data-seed]').value = '-4';
    await panel.submit();
    expect(panel.state()).toBe('failed');
    expect(host.node('[data-status]').innerHTML).toMatch(/whole number/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('attributes a blank key to a fighter rather than saying "something failed"', async () => {
    const { host, panel } = mountWithTransport();
    host.node('[data-key="1"]').value = '';
    await panel.submit();
    expect(host.node('[data-status]').innerHTML).toContain('Fighter 2');
  });

  it('surfaces a ByokKeyError verbatim, redaction included', async () => {
    const host = createHost();
    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: () =>
        Promise.reject(
          new ByokKeyError({
            agentIndex: 1,
            provider: 'Cerebras',
            model: 'llama3.1-8b',
            failure: 'rate-limited',
            detail: 'quota exhausted',
          }),
        ),
    });
    host.node('[data-key="0"]').value = 'gsk_p1_key_do_not_use_000001';
    host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';
    await panel.submit();
    expect(host.node('[data-status]').innerHTML).toContain('Fighter 2');
    expect(host.node('[data-status]').innerHTML).toContain('Cerebras');
    expect(host.node('[data-status]').innerHTML).toContain('out of quota');
  });
});
