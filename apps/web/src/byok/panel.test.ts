import { describe, expect, it } from 'vitest';
import type { CommandLog } from '@tokenbrawl/contracts';
import { createFakeTransport, chatCompletionBody } from '../testing/byok-transport';
import { buildDemoLog } from '../testing/demo-log';
import { byokCatalogue } from './catalogue';
import { ByokKeyError } from './client';
import type { KeyStorage } from './keys';
import {
  byokMarkup,
  cliOnlyNotice,
  modelMarkup,
  mountByokPanel,
  type ByokHost,
  type ByokNode,
} from './panel';
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
  it('lists every unofferable provider, labelled and disabled', () => {
    const markup = byokMarkup(byokCatalogue());
    expect(markup).toContain('OpenRouter — ADVANCED ONLY');
    expect(markup).toContain('xAI — ADVANCED ONLY');
    // Disabled, not absent. A hidden provider tells a visitor nothing.
    expect(markup).toMatch(/<option value="openrouter" disabled>/);
    expect(markup).toMatch(/<option value="xai" disabled>/);
  });

  it('says which providers cannot run here in text, not only as a disabled option', () => {
    // Chrome's accessibility tree omits a disabled `<option>` entirely, so the
    // option alone tells a screen-reader user nothing -- found by snapshotting
    // the built page, not by a test. The sentence carries the reason too.
    const notice = cliOnlyNotice(byokCatalogue());
    expect(notice).toContain('OpenRouter');
    expect(notice).toContain('xAI');
    // The lead-in and the reasons must agree: 4.7 makes both reachable under
    // Advanced, so a notice that said 'not runnable in a browser' would be
    // contradicted by its own parenthesis.
    expect(notice).toMatch(/Not in this picker, and where each one does work/);
    expect(notice).toMatch(/Advanced/);
    expect(byokMarkup(byokCatalogue())).toContain(notice);
  });

  it('says nothing when every provider can run here', () => {
    const browserOnly = byokCatalogue().filter((option) => option.access === 'browser');
    expect(cliOnlyNotice(browserOnly)).toBe('');
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
    expect(host.node('[data-model="1"]').innerHTML).toContain('gemma-4-31b');
    expect(host.node('[data-model="1"]').innerHTML).not.toContain('llama-3.1-8b-instant');
    expect(host.node('[data-model="1"]').value).toBe('gemini-3.1-flash-lite');
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
            model: 'gpt-oss-120b',
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
    // The detail, verbatim. The sentence around it belongs to `failureSentence`
    // and is asserted there -- this test is about the panel not editing either.
    expect(host.node('[data-status]').innerHTML).toContain('quota exhausted');
    expect(panel.state()).toBe('failed');
  });
});

describe('what the panel says while a Match is paused (4.8, AC5)', () => {
  // One real log, built once and awaited per case: these cases are about the
  // panel's states, and re-simulating a Match for each would be slower and no
  // stronger. `describe` cannot await, so the promise is the shared value.
  const finished = buildDemoLog();

  /**
   * A run the test drives by hand: it announces a wait, then a completed call,
   * then resolves. Nothing else can reproduce the *transition*, which is the
   * only part of AC5 that is not already covered at the runner.
   */
  function pausingPanel(finished: CommandLog) {
    const host = createHost();
    const gate: { release: (() => void) | null } = { release: null };

    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: (config: ByokRunConfig) =>
        new Promise<CommandLog>((resolve) => {
          config.onCall?.(4);
          config.onWait?.(4);
          gate.release = (): void => {
            config.onCall?.(5);
            resolve(finished);
          };
        }),
    });
    host.node('[data-key="0"]').value = 'gsk_p1_key_do_not_use_000001';
    host.node('[data-key="1"]').value = 'gsk_p2_key_do_not_use_000002';
    return { host, panel, gate };
  }

  it('enters a waiting state carrying a count of completed calls', async () => {
    const { host, panel, gate } = pausingPanel(await finished);
    const running = panel.submit();

    expect(panel.state()).toBe('waiting');
    const said = host.node('[data-status]').innerHTML;
    expect(said).toContain('4 calls made so far');
    expect(said).toMatch(/resumes at the same Decision Point/);

    gate.release?.();
    await running;
  });

  it('names no duration, no estimate and no provider (INV-3)', async () => {
    const { host, panel, gate } = pausingPanel(await finished);
    const running = panel.submit();
    const said = host.node('[data-status]').innerHTML;

    // A number followed by a time unit is the shape of every banned form --
    // "12s", "waiting 47 seconds", "about 2 minutes". The call count is a bare
    // integer and survives this.
    expect(said).not.toMatch(/\d+\s*(ms|s\b|sec|second|minute|hour)/i);
    expect(said).not.toMatch(/Groq|Cerebras|Gemini|Google|retry|remaining/i);
    expect(said).not.toContain('%');

    gate.release?.();
    await running;
  });

  it('returns to running as soon as a call completes', async () => {
    const { panel, gate } = pausingPanel(await finished);
    const running = panel.submit();
    expect(panel.state()).toBe('waiting');

    gate.release?.();
    await running;
    // The last thing announced before `done` was the resume, not the pause: a
    // visitor who looked away must not come back to a stale pause message.
    expect(panel.state()).toBe('done');
  });

  it('counts a paused Match as in flight, so nothing else spends the quota', async () => {
    // Only the run button is disabled during a Match. A pause that read as idle
    // would re-open both `Fetch my models` and a second submit -- against the
    // very quota the Match is waiting on.
    const { host, panel, gate } = pausingPanel(await finished);
    const running = panel.submit();
    expect(panel.state()).toBe('waiting');

    await panel.discover(0);
    expect(panel.state()).toBe('waiting');
    expect(host.node('[data-status]').innerHTML).toContain('calls made so far');

    await panel.submit();
    expect(panel.state()).toBe('waiting');

    gate.release?.();
    await running;
  });
});

/**
 * Story 4.7's surface: the Advanced disclosure, what it echoes back, and what
 * "fetch my models" does to the picker.
 */
describe('progressive disclosure: the simple path is untouched (4.7)', () => {
  it('keeps provider, model and key outside the disclosure', () => {
    const markup = byokMarkup(byokCatalogue());
    const advancedAt = markup.indexOf('<details');
    expect(advancedAt).toBeGreaterThan(-1);
    // Every control 4.6 shipped appears before the first `<details>`, which is
    // the mechanical form of "a visitor who wants the simple thing must not
    // have to read about base URLs to find it".
    const simple = markup.slice(0, advancedAt);
    for (const control of ['data-provider="0"', 'data-model="0"', 'data-key="0"']) {
      expect(simple).toContain(control);
    }
  });

  it('puts every 4.7 control inside it, collapsed', () => {
    const markup = byokMarkup(byokCatalogue());
    for (const control of [
      'data-custom="0"',
      'data-base="0"',
      'data-discover="0"',
      'data-preset="0"',
    ]) {
      expect(markup).toContain(control);
    }
    // No `open` attribute anywhere: collapsed is the default state.
    expect(markup).not.toMatch(/<details[^>]*\bopen\b/);
  });
});

describe('the limits a visitor reads before choosing (4.7, AC2)', () => {
  it('carries RPM and RPD in each model option', () => {
    // The mounted shell shows the first browser provider's models; the others
    // are rendered by the same function when the picker changes, so both are
    // checked through it.
    expect(byokMarkup(byokCatalogue())).toContain(
      'llama-3.1-8b-instant — 30 RPM / 14,400 RPD — 240 matches/day',
    );
    const google = byokCatalogue().find((option) => option.id === 'google-ai-studio');
    expect(modelMarkup(google)).toContain('gemma-4-31b — 30 RPM / 14,400 RPD — 240 matches/day');
  });

  it('states a slow provider before the run, on selection', () => {
    const { host } = mountWithTransport();
    host.node('[data-provider="0"]').value = 'cerebras';
    host.fire('[data-provider="0"]', 'change');
    expect(host.node('[data-limits="0"]').innerHTML).toContain('12 minutes');
    expect(host.node('[data-limits="0"]').innerHTML).toContain('5 requests a minute');
  });

  it('says nothing for a model with nothing unusual about it', () => {
    const { host } = mountWithTransport();
    host.node('[data-provider="0"]').value = 'google-ai-studio';
    host.fire('[data-provider="0"]', 'change');
    host.node('[data-model="0"]').value = 'gemma-4-31b';
    host.fire('[data-model="0"]', 'change');
    expect(host.node('[data-limits="0"]').innerHTML).toBe('');
  });

  it('marks a typed model as inheriting the provider defaults', () => {
    const { host } = mountWithTransport();
    host.node('[data-custom="0"]').value = 'a-model-nobody-listed';
    host.fire('[data-custom="0"]', 'input');
    expect(host.node('[data-limits="0"]').innerHTML).toContain('No measured free-tier row');
  });
});

describe('the origin echoed back before the first request (4.7, AC6)', () => {
  it('names the origin as soon as a URL is typed', () => {
    const { host } = mountWithTransport();
    host.node('[data-base="0"]').value = 'https://openrouter.ai/api/v1';
    host.fire('[data-base="0"]', 'input');
    const shown = host.node('[data-origin="0"]').innerHTML;
    expect(shown).toContain('https://openrouter.ai');
    expect(shown).toContain('no other origin');
  });

  it('refuses plaintext where it was typed, not at request time', () => {
    const { host } = mountWithTransport();
    host.node('[data-base="0"]').value = 'http://openrouter.ai/api/v1';
    host.fire('[data-base="0"]', 'input');
    expect(host.node('[data-origin="0"]').innerHTML).toMatch(/not https/);
  });

  it('fills the field from a preset, and echoes that origin', () => {
    const { host } = mountWithTransport();
    host.node('[data-preset="0"]').value = 'https://api.x.ai/v1';
    host.fire('[data-preset="0"]', 'change');
    expect(host.node('[data-base="0"]').value).toBe('https://api.x.ai/v1');
    expect(host.node('[data-origin="0"]').innerHTML).toContain('https://api.x.ai');
  });

  it('says nothing at all while the field is empty', () => {
    const { host } = mountWithTransport();
    expect(host.node('[data-origin="0"]').innerHTML).toBe('');
  });
});

describe('fetch my models (4.7, AC4)', () => {
  function mountWithDiscovery(models: readonly string[] | Error) {
    const host = createHost();
    const asked: { provider: string; baseUrl: string; apiKey: string }[] = [];
    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: () => Promise.reject(new Error('not used')),
      discover: (config) => {
        asked.push({
          provider: config.provider,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
        });
        return models instanceof Error ? Promise.reject(models) : Promise.resolve(models);
      },
    });
    host.node('[data-key="0"]').value = 'gsk_visitor_key';
    return { host, panel, asked };
  }

  it('repopulates the picker from what the provider said (AC4)', async () => {
    const { host, panel } = mountWithDiscovery(['a-brand-new-model', 'llama-3.1-8b-instant']);
    await panel.discover(0);

    const options = host.node('[data-model="0"]').innerHTML;
    // The measured models stay, and the newly-discovered one is appended.
    expect(options).toContain('llama-3.1-8b-instant');
    expect(options).toContain('a-brand-new-model');
    // Appended once, not twice: a discovered model already on the list is the
    // ordinary case, not a duplicate row.
    expect(options.match(/value="llama-3\.1-8b-instant"/g)).toHaveLength(1);
    // And it carries the provider defaults, said out loud.
    expect(options).toContain(
      'a-brand-new-model — 30 RPM / 250 RPD — 4 matches/day (provider defaults)',
    );
  });

  it('asks with the pasted key and this fighter own selection', async () => {
    const { host, panel, asked } = mountWithDiscovery(['m']);
    host.node('[data-base="0"]').value = 'https://openrouter.ai/api/v1';
    host.fire('[data-base="0"]', 'input');
    await panel.discover(0);
    expect(asked).toStrictEqual([
      { provider: 'groq', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'gsk_visitor_key' },
    ]);
  });

  it('keeps the list it had when the key is rejected', async () => {
    const { host, panel } = mountWithDiscovery(new Error('failed with status 401'));
    const before = host.node('[data-model="0"]').innerHTML;
    await panel.discover(0);
    expect(host.node('[data-model="0"]').innerHTML).toBe(before);
    expect(panel.state()).toBe('failed');
    expect(host.node('[data-status]').innerHTML).toContain('401');
    expect(host.node('[data-status]').innerHTML).toContain('Fighter 1');
  });

  it('drops a discovered list when the provider changes under it', async () => {
    // Groq model ids do not exist on Cerebras. A list that survived the switch
    // would offer selections guaranteed to 404.
    const { host, panel } = mountWithDiscovery(['a-brand-new-model']);
    await panel.discover(0);
    expect(host.node('[data-model="0"]').innerHTML).toContain('a-brand-new-model');

    host.node('[data-provider="0"]').value = 'cerebras';
    host.fire('[data-provider="0"]', 'change');
    expect(host.node('[data-model="0"]').innerHTML).not.toContain('a-brand-new-model');
  });

  it('refuses to fetch while a Match is in flight', async () => {
    // Only the run button is disabled during a Match, so this is reachable --
    // and it would spend a request against the very quota the Match is running
    // on, and overwrite the live region's running message with one about
    // models. Found by walking the branch rather than by a failing test.
    const host = createHost();
    const asked: string[] = [];
    const gate: { release: () => void } = { release: (): void => undefined };
    const held = new Promise<never>((_, reject) => {
      gate.release = (): void => reject(new Error('stopped on purpose'));
    });

    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: () => held,
      discover: (config) => {
        asked.push(config.provider);
        return Promise.resolve(['a-brand-new-model']);
      },
    });
    host.node('[data-key="0"]').value = 'k1';
    host.node('[data-key="1"]').value = 'k2';

    const running = panel.submit();
    expect(panel.state()).toBe('running');
    await panel.discover(0);
    expect(asked).toStrictEqual([]);
    expect(host.node('[data-model="0"]').innerHTML).not.toContain('a-brand-new-model');

    gate.release();
    await running;

    // And it works again once the Match is over.
    await panel.discover(0);
    expect(asked).toStrictEqual(['groq']);
  });

  it('leaves the other fighter picker alone', async () => {
    const { host, panel } = mountWithDiscovery(['a-brand-new-model']);
    await panel.discover(0);
    expect(host.node('[data-model="1"]').innerHTML).not.toContain('a-brand-new-model');
  });
});

describe('what the form hands the runner (4.7, AC3, AC5)', () => {
  it('prefers a typed model over the picker selection, and passes a base URL through', async () => {
    const host = createHost();
    const seen: ByokRunConfig[] = [];
    const panel = mountByokPanel(host, {
      onLog: (): void => undefined,
      run: (config) => {
        seen.push(config);
        return Promise.reject(
          new ByokKeyError({
            agentIndex: 0,
            provider: 'Groq',
            model: 'm',
            failure: 'provider-error',
            detail: 'stopped here on purpose',
          }),
        );
      },
    });
    host.node('[data-key="0"]').value = 'k1';
    host.node('[data-key="1"]').value = 'k2';
    host.node('[data-custom="0"]').value = 'openai/gpt-oss-120b';
    host.node('[data-base="1"]').value = 'https://gw.example/v1';

    await panel.submit();

    expect(seen).toHaveLength(1);
    expect(seen[0].fighters[0].model).toBe('openai/gpt-oss-120b');
    expect(seen[0].fighters[0].baseUrl).toBe('');
    expect(seen[0].fighters[1].baseUrl).toBe('https://gw.example/v1');
  });
});
