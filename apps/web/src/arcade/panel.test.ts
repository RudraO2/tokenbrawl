import { describe, expect, it } from 'vitest';
import type { Action, CommandLogV2 } from '@tokenbrawl/contracts';
import { runArcadeMatch } from './run';
import {
  arcadeMarkup,
  mountArcadePanel,
  type ArcadeHost,
  type ArcadeKeyEvent,
  type ArcadeNode,
  type ArcadePanelDeps,
} from './panel';

/**
 * Story 9.2's surface, driven without a DOM -- same discipline as
 * `byok/panel.test.ts`: structural fakes under Vitest's default `node`
 * environment.
 */

interface FakePanelHost extends ArcadeHost {
  readonly node: (selector: string) => ArcadeNode;
  readonly fire: (selector: string, type: 'click' | 'keydown', event?: ArcadeKeyEvent) => void;
}

function createHost(): FakePanelHost {
  const nodes = new Map<string, ArcadeNode>();
  const listeners = new Map<string, ((event?: ArcadeKeyEvent) => void)[]>();
  const state = { html: '' };

  const child = (selector: string): ArcadeNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: ArcadeNode = {
      innerHTML: '',
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
    querySelector: (selector: string): ArcadeNode | null => child(selector),
    node: child,
    fire: (selector: string, type: 'click' | 'keydown', event?: ArcadeKeyEvent): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener(event);
      }
    },
  };
}

const KEYS = ['ArrowRight', 'z', 'x', 'c', 'ArrowLeft'] as const;

/** Fires a rotating, legal keydown sequence until the Match settles. */
async function driveByKeyboard(host: FakePanelHost, logs: CommandLogV2[], maxTicks = 5_000): Promise<void> {
  let settled = false;
  const before = logs.length;
  let index = 0;
  let iterations = 0;
  while (logs.length === before && !settled && iterations < maxTicks) {
    host.fire('[data-arcade-keys]', 'keydown', { key: KEYS[index % KEYS.length] });
    index += 1;
    iterations += 1;
    await Promise.resolve();
    settled = logs.length > before;
  }
}

describe('the panel shell (mount/unmount)', () => {
  it('mounts a Play vs CPU button and an idle status', () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    const panel = mountArcadePanel(host, { onLog: (log) => logs.push(log) });

    expect(host.innerHTML).toContain('Play vs CPU');
    expect(panel.state()).toBe('idle');
    expect(host.node('[data-arcade-status]').innerHTML).toContain('No key, no signup');
  });

  it('produces the markup arcadeMarkup() describes', () => {
    expect(arcadeMarkup()).toContain('data-arcade-play');
    expect(arcadeMarkup()).toContain('data-arcade-keys');
    for (const action of ['advance', 'retreat', 'attack', 'block', 'special']) {
      expect(arcadeMarkup()).toContain(`data-arcade-action="${action}"`);
    }
  });

  it('re-mounting into a fresh host does not throw and starts idle again', () => {
    const first = createHost();
    mountArcadePanel(first, { onLog: (): void => undefined });
    const second = createHost();
    const panel = mountArcadePanel(second, { onLog: (): void => undefined });
    expect(panel.state()).toBe('idle');
  });
});

describe('a scripted keyboard sequence completes a Match (AC1, AC4)', () => {
  it('runs to a terminal state and hands the completed log to onLog', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    const panel = mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });

    host.fire('[data-arcade-play]', 'click');
    expect(panel.state()).toBe('running');

    await driveByKeyboard(host, logs);

    expect(logs).toHaveLength(1);
    expect(logs[0].schemaVersion).toBe('2.0.0');
    expect(logs[0].agents[0].kind).toBe('human');
    expect(panel.state()).toBe('done');
    expect(host.node('[data-arcade-status]').innerHTML).toContain('excluded from every rating');
  });

  it('disables nothing permanently: play button re-enables after the Match', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });

    host.fire('[data-arcade-play]', 'click');
    expect(host.node('[data-arcade-play]').disabled).toBe(true);
    await driveByKeyboard(host, logs);
    expect(host.node('[data-arcade-play]').disabled).toBe(false);
  });

  it('drives a Match to completion through the on-screen buttons too', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runArcadeMatch(config),
      seed: 4_602,
    });

    host.fire('[data-arcade-play]', 'click');

    const buttons = ['advance', 'attack', 'block', 'special', 'retreat'] as const;
    let index = 0;
    let iterations = 0;
    while (logs.length === 0 && iterations < 5_000) {
      host.fire(`[data-arcade-action="${buttons[index % buttons.length]}"]`, 'click');
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }

    expect(logs).toHaveLength(1);
  });
});

describe('an unmapped or illegal key is ignored, never reaching the Match (I/O matrix row 2)', () => {
  it('never crashes on Escape, and the Match still completes once legal input resumes', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });

    host.fire('[data-arcade-play]', 'click');

    expect(() => host.fire('[data-arcade-keys]', 'keydown', { key: 'Escape' })).not.toThrow();

    let index = 0;
    let iterations = 0;
    while (logs.length === 0 && iterations < 5_000) {
      host.fire('[data-arcade-keys]', 'keydown', { key: 'Escape' });
      host.fire('[data-arcade-keys]', 'keydown', { key: KEYS[index % KEYS.length] });
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }

    expect(logs).toHaveLength(1);
  });

  it('does nothing before the Match has started (no handle to feed)', () => {
    const host = createHost();
    mountArcadePanel(host, { onLog: (): void => undefined });
    expect(() => host.fire('[data-arcade-keys]', 'keydown', { key: 'z' })).not.toThrow();
  });

  it('ignores a keydown event with no key at all', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });
    host.fire('[data-arcade-play]', 'click');
    expect(() => host.fire('[data-arcade-keys]', 'keydown', {})).not.toThrow();
    await driveByKeyboard(host, logs);
    expect(logs).toHaveLength(1);
  });
});

describe('a rejected match promise recovers the panel rather than leaving it stuck (P1)', () => {
  it('shows an error state and re-enables Play instead of a stuck "Fighting..." state', async () => {
    const host = createHost();
    let rejectLog: ((error: unknown) => void) | undefined;
    const panel = mountArcadePanel(host, {
      onLog: (): void => undefined,
      run: () => ({
        log: new Promise((_resolve, reject) => {
          rejectLog = reject;
        }),
        feedInput: (): void => undefined,
      }),
    });

    host.fire('[data-arcade-play]', 'click');
    expect(panel.state()).toBe('running');
    expect(host.node('[data-arcade-play]').disabled).toBe(true);

    rejectLog?.(new Error('match blew up'));
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.state()).toBe('error');
    expect(host.node('[data-arcade-play]').disabled).toBe(false);
    expect(host.node('[data-arcade-status]').innerHTML).toContain('match blew up');
  });

  it('never calls onLog when the match rejects', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    let rejectLog: ((error: unknown) => void) | undefined;
    mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: () => ({
        log: new Promise((_resolve, reject) => {
          rejectLog = reject;
        }),
        feedInput: (): void => undefined,
      }),
    });

    host.fire('[data-arcade-play]', 'click');
    rejectLog?.(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();

    expect(logs).toHaveLength(0);
  });

  it('recovers from a synchronous throw when starting the match', () => {
    const host = createHost();
    const panel = mountArcadePanel(host, {
      onLog: (): void => undefined,
      run: () => {
        throw new Error('cannot start');
      },
    });

    host.fire('[data-arcade-play]', 'click');

    expect(panel.state()).toBe('error');
    expect(host.node('[data-arcade-play]').disabled).toBe(false);
  });
});

describe('the key-capture div receives focus when a Match starts (P3)', () => {
  it('calls .focus() on [data-arcade-keys] right when play() runs', () => {
    const host = createHost();
    let focusCalls = 0;
    const keysNode = host.node('[data-arcade-keys]');
    keysNode.focus = (): void => {
      focusCalls += 1;
    };

    mountArcadePanel(host, {
      onLog: (): void => undefined,
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });

    host.fire('[data-arcade-play]', 'click');

    expect(focusCalls).toBe(1);
  });

  it('never throws when the host node has no focus method (structural optionality)', () => {
    const host = createHost();
    mountArcadePanel(host, {
      onLog: (): void => undefined,
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });

    expect(() => host.fire('[data-arcade-play]', 'click')).not.toThrow();
  });
});

/**
 * Story 10.6.
 *
 * Two kinds of case here, and the split is deliberate.
 *
 * The messaging cases drive a **fake** `run` whose `onLegalActions` this file
 * calls by hand. That is the only way to state "when the gauge arms, the panel
 * says so" as a property of the panel rather than as a property of one
 * particular Match: a real Match arms on whichever Decision Point it happens to
 * arm on, and a test that waited for it would be asserting the balance table.
 *
 * The one case that must be about a real Match -- that a human can reach a full
 * bar at all -- lives in `run.test.ts`, where the log can be inspected.
 */

interface FakeRun {
  readonly fed: readonly string[];
  readonly arm: (armed: boolean) => void;
  readonly finish: (log: CommandLogV2) => void;
}

/** A `run` that never finishes on its own, so the panel can be poked at mid-Match. */
function createFakeRun(): { readonly run: ArcadePanelDeps['run']; readonly handle: FakeRun } {
  const fed: string[] = [];
  const captured: {
    onLegalActions?: (legalActions: readonly Action[]) => void;
    resolve?: (log: CommandLogV2) => void;
  } = {};

  return {
    run: (config) => {
      captured.onLegalActions = config.onLegalActions;
      return {
        log: new Promise<CommandLogV2>((resolve) => {
          captured.resolve = resolve;
        }),
        feedInput: (raw: string): void => {
          fed.push(raw);
        },
      };
    },
    handle: {
      get fed(): readonly string[] {
        return fed;
      },
      arm: (armed: boolean): void => {
        captured.onLegalActions?.(
          armed ? ['advance', 'retreat', 'attack', 'block', 'special'] : ['advance', 'retreat', 'attack', 'block'],
        );
      },
      finish: (log: CommandLogV2): void => {
        captured.resolve?.(log);
      },
    },
  };
}

describe('the panel tells the player the Ultimate is ready (Story 10.6, AC3)', () => {
  it('shows nothing before a Match has started', () => {
    const host = createHost();
    mountArcadePanel(host, { onLog: (): void => undefined });
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });

  it('surfaces the affordance the moment the gauge reports itself full', () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');

    handle.arm(true);

    // Named by the key, because the affordance exists for a player who never
    // read the intro paragraph. "Ultimate ready" alone would tell them a fact
    // and not what to do with it.
    expect(host.node('[data-arcade-ultimate]').innerHTML).toContain('Ultimate ready');
    expect(host.node('[data-arcade-ultimate]').innerHTML).toContain('L');
  });

  it('clears it again when the bar is spent', () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(true);
    expect(host.node('[data-arcade-ultimate]').innerHTML).not.toBe('');

    handle.arm(false);
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });

  it('clears it when the Match ends', async () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, { onLog: (log) => logs.push(log), run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(true);
    handle.finish({ schemaVersion: '2.0.0' } as unknown as CommandLogV2);
    await Promise.resolve();
    await Promise.resolve();

    expect(logs).toHaveLength(1);
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });

  it('does not carry a previous Match’s armed state into a new one', async () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(true);
    handle.finish({ schemaVersion: '2.0.0' } as unknown as CommandLogV2);
    await Promise.resolve();
    await Promise.resolve();

    host.fire('[data-arcade-play]', 'click');
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });
});

describe('pressing L below a full gauge says why (Story 10.6, AC2)', () => {
  it('explains the drop instead of doing nothing visible', () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(false);
    host.fire('[data-arcade-keys]', 'keydown', { key: 'l' });

    // A silent no-op is indistinguishable from a broken key -- the same failure
    // Story 9.3's picker guard exists to prevent.
    expect(host.node('[data-arcade-status]').innerHTML).toContain('Ultimate not ready');
    expect(host.node('[data-arcade-status]').innerHTML).toContain('Super Gauge');
  });

  it('still forwards the press, so the Agent remains the only thing that drops it', () => {
    // The load-bearing one. If the panel had started refusing to forward the
    // key, the legality rule would now live in two places and could drift.
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(false);
    host.fire('[data-arcade-keys]', 'keydown', { key: 'l' });

    expect(handle.fed).toStrictEqual(['l']);
  });

  it('says nothing of the sort when the gauge is full', () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(true);
    host.fire('[data-arcade-keys]', 'keydown', { key: 'l' });

    expect(host.node('[data-arcade-status]').innerHTML).not.toContain('Ultimate not ready');
    expect(handle.fed).toStrictEqual(['l']);
  });

  it('gives the on-screen Special button the identical explanation', () => {
    // Touch and keyboard go through one path. A player on a phone getting
    // silence where a player on a laptop gets a sentence is the same defect
    // AC2 names, wearing a different input device.
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(false);
    host.fire('[data-arcade-action="special"]', 'click');

    expect(host.node('[data-arcade-status]').innerHTML).toContain('Ultimate not ready');
    expect(handle.fed).toStrictEqual(['special']);
  });

  it('leaves every other key silent, however unmapped', () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(false);
    for (const key of ['z', 'x', 'ArrowLeft', 'ArrowRight', 'Escape']) {
      host.fire('[data-arcade-keys]', 'keydown', { key });
    }

    expect(host.node('[data-arcade-status]').innerHTML).not.toContain('Ultimate not ready');
  });

  it('treats C exactly as it treats L, since both ask for the same Action', () => {
    const host = createHost();
    const { run, handle } = createFakeRun();
    mountArcadePanel(host, { onLog: (): void => undefined, run });

    host.fire('[data-arcade-play]', 'click');
    handle.arm(false);
    host.fire('[data-arcade-keys]', 'keydown', { key: 'c' });

    expect(host.node('[data-arcade-status]').innerHTML).toContain('Ultimate not ready');
  });
});

describe('the controls are documented where a player will read them (Story 10.6, AC5)', () => {
  it('names L in the panel’s own help text', () => {
    // A binding nobody is told about is not a feature.
    expect(arcadeMarkup()).toContain('L throws the Ultimate');
    expect(arcadeMarkup()).toContain('data-arcade-ultimate');
  });

  it('keeps the on-screen Special button, which is the touch path (AC1)', () => {
    expect(arcadeMarkup()).toContain('data-arcade-action="special"');
  });
});

describe('a second play click while one is in flight is ignored', () => {
  it('does not start a second Match', async () => {
    const host = createHost();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, {
      onLog: (log) => logs.push(log),
      run: (config) => runArcadeMatch(config),
      seed: 4_601,
    });

    host.fire('[data-arcade-play]', 'click');
    host.fire('[data-arcade-play]', 'click');

    await driveByKeyboard(host, logs);
    expect(logs).toHaveLength(1);
  });
});
