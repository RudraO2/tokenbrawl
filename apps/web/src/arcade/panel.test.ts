import { describe, expect, it } from 'vitest';
import type { CommandLogV2, TerminalResult } from '@tokenbrawl/contracts';
import type { HostView } from '../main';
import type {
  ArcadeRoundEnd,
  ArcadeSessionConfig,
  ArcadeSessionHandle,
  ArcadeSetEnd,
} from './session';
import {
  arcadeMarkup,
  mountArcadePanel,
  type ArcadeHost,
  type ArcadeKeyEvent,
  type ArcadeNode,
} from './panel';

/**
 * Story 12.7's surface: an arcade set is best-of-three, driven without a DOM.
 *
 * The set flow is driven through a **fake session** injected as `runSession`, so
 * "a round ends, the pips fill, the overlay holds, the set ends on its result
 * screen" is a property of the panel rather than of one particular set of real
 * Matches -- the same discipline Story 10.6 used for its `run` fake.
 */

interface FakePanelHost extends ArcadeHost {
  readonly node: (selector: string) => ArcadeNode;
  readonly fire: (selector: string, type: 'click' | 'keydown', event?: ArcadeKeyEvent) => void;
  readonly classOf: (selector: string) => string;
}

function createHost(): FakePanelHost {
  const nodes = new Map<string, ArcadeNode>();
  const listeners = new Map<string, ((event?: ArcadeKeyEvent) => void)[]>();
  const classes = new Map<string, string>();
  const state = { html: '' };

  const child = (selector: string): ArcadeNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: ArcadeNode = {
      innerHTML: '',
      disabled: false,
      setAttribute: (name, value): void => {
        if (name === 'class') {
          classes.set(selector, value);
        }
      },
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
    classOf: (selector: string): string => classes.get(selector) ?? '',
    fire: (selector: string, type: 'click' | 'keydown', event?: ArcadeKeyEvent): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener(event);
      }
    },
  };
}

function resultFor(outcome: 'p1' | 'p2' | 'draw', endReason: 'ko' | 'timeout' = 'timeout'): TerminalResult {
  return { outcome, endTick: 1200, endReason, healthRemaining: [3, 100] };
}

function logFor(outcome: 'p1' | 'p2' | 'draw'): CommandLogV2 {
  return {
    schemaVersion: '2.0.0',
    result: resultFor(outcome),
    agents: [
      { id: 'p1:human', kind: 'human' },
      { id: 'p2:bot:random', kind: 'bot' },
    ],
  } as unknown as CommandLogV2;
}

/** A `runSession` a test drives by hand: it captures the config and records fed input. */
interface FakeSession {
  readonly runSession: (config: ArcadeSessionConfig) => ArcadeSessionHandle;
  readonly config: () => ArcadeSessionConfig;
  readonly starts: () => number;
  readonly fed: readonly string[];
  readonly cancelled: () => boolean;
}

function createFakeSession(): FakeSession {
  const captured: { config?: ArcadeSessionConfig; cancelled: boolean; starts: number } = {
    cancelled: false,
    starts: 0,
  };
  const fed: string[] = [];
  return {
    runSession: (config): ArcadeSessionHandle => {
      captured.config = config;
      captured.starts += 1;
      return {
        feedInput: (raw: string): void => {
          fed.push(raw);
        },
        roundsWon: (): readonly [number, number] => [0, 0],
        cancel: (): void => {
          captured.cancelled = true;
        },
      };
    },
    config: (): ArcadeSessionConfig => {
      if (captured.config === undefined) {
        throw new Error('runSession was never called');
      }
      return captured.config;
    },
    starts: (): number => captured.starts,
    fed,
    cancelled: (): boolean => captured.cancelled,
  };
}

const roundEnd = (
  round: number,
  outcome: 'p1' | 'p2' | 'draw',
  roundsWon: readonly [number, number],
  setOver: boolean,
): ArcadeRoundEnd => ({
  round,
  log: logFor(outcome),
  result: resultFor(outcome),
  roundsWon,
  setOver,
});

const setEnd = (
  roundsWon: readonly [number, number],
  humanWon: boolean,
  logs: readonly CommandLogV2[],
): ArcadeSetEnd => ({ roundsWon, humanWon, logs });

describe('the panel shell (mount)', () => {
  it('mounts a Play vs CPU button and an idle status', () => {
    const host = createHost();
    const panel = mountArcadePanel(host, {});

    expect(host.innerHTML).toContain('Play vs CPU');
    expect(panel.state()).toBe('idle');
    expect(host.node('[data-arcade-status]').innerHTML).toContain('No key, no signup');
  });

  it('produces the markup arcadeMarkup() describes, including the set-result controls', () => {
    expect(arcadeMarkup()).toContain('data-arcade-play');
    expect(arcadeMarkup()).toContain('data-arcade-keys');
    for (const action of ['advance', 'retreat', 'attack', 'block', 'special']) {
      expect(arcadeMarkup()).toContain(`data-arcade-action="${action}"`);
    }
    // Story 12.7's set-result screen: a result line and two keyboard-reachable
    // `tb-button` controls (the `--tb-accent` focus outline comes with the class).
    expect(arcadeMarkup()).toContain('data-arcade-setresult');
    expect(arcadeMarkup()).toContain('data-arcade-rematch');
    expect(arcadeMarkup()).toContain('data-arcade-select');
    expect(arcadeMarkup()).toContain('best of three');
  });

  it('re-mounting into a fresh host does not throw and starts idle again', () => {
    mountArcadePanel(createHost(), {});
    const panel = mountArcadePanel(createHost(), {});
    expect(panel.state()).toBe('idle');
  });
});

describe('a best-of-three set plays out on one screen (12.7)', () => {
  it('starts a session on Play and forwards input to the round in play', () => {
    const host = createHost();
    const fake = createFakeSession();
    const panel = mountArcadePanel(host, { runSession: fake.runSession, seed: 4_601 });

    host.fire('[data-arcade-play]', 'click');
    expect(panel.state()).toBe('running');
    expect(fake.starts()).toBe(1);
    expect(fake.config().seed).toBe(4_601);

    host.fire('[data-arcade-keys]', 'keydown', { key: 'z' });
    host.fire('[data-arcade-action="attack"]', 'click');
    expect(fake.fed).toStrictEqual(['z', 'attack']);
  });

  it('ends the set on its result screen and re-enables Play (a rematch)', () => {
    const host = createHost();
    const fake = createFakeSession();
    const panel = mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onSetEnd?.(setEnd([2, 0], true, [logFor('p1'), logFor('p1')]));

    expect(panel.state()).toBe('done');
    expect(host.node('[data-arcade-play]').disabled).toBe(false);
    // The result screen is shown and names the win.
    expect(host.classOf('[data-arcade-setresult]')).toContain('tb-arcade-setresult--shown');
    expect(host.node('[data-arcade-setresult-text]').innerHTML).toContain('win');
  });

  it('names a loss with the score the other way round', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onSetEnd?.(setEnd([1, 2], false, [logFor('p2'), logFor('p1'), logFor('p2')]));

    expect(host.node('[data-arcade-setresult-text]').innerHTML).toContain('lose');
    expect(host.node('[data-arcade-setresult-text]').innerHTML).toContain('2-1');
  });

  it('a round that does not end the set holds and then resolves for the next round', async () => {
    const host = createHost();
    const fake = createFakeSession();
    const logs: CommandLogV2[] = [];
    mountArcadePanel(host, {
      runSession: fake.runSession,
      onRoundLog: (log) => logs.push(log),
    });

    host.fire('[data-arcade-play]', 'click');
    // A non-terminal round returns a hold that resolves at once with no view.
    await fake.config().onRoundEnd?.(roundEnd(0, 'p1', [1, 0], false));
    // The round's log was handed off, and the result screen is NOT shown mid-set.
    expect(logs).toHaveLength(1);
    expect(host.classOf('[data-arcade-setresult]')).not.toContain('tb-arcade-setresult--shown');
    expect(host.node('[data-arcade-setresult-text]').innerHTML).toBe('');
  });

  it('re-mounting the set from the result screen hides it and starts a fresh session', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onSetEnd?.(setEnd([2, 0], true, [logFor('p1'), logFor('p1')]));
    expect(host.classOf('[data-arcade-setresult]')).toContain('tb-arcade-setresult--shown');

    host.fire('[data-arcade-rematch]', 'click');
    expect(fake.starts()).toBe(2);
    expect(host.classOf('[data-arcade-setresult]')).not.toContain('tb-arcade-setresult--shown');
  });

  it('returns to character select through the callback the shell wired', () => {
    const host = createHost();
    const fake = createFakeSession();
    let returned = 0;
    mountArcadePanel(host, {
      runSession: fake.runSession,
      onReturnToSelect: () => {
        returned += 1;
      },
    });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onSetEnd?.(setEnd([0, 2], false, [logFor('p2'), logFor('p2')]));
    host.fire('[data-arcade-select]', 'click');
    expect(returned).toBe(1);
  });

  it('a second Play while a set is running is ignored', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    host.fire('[data-arcade-play]', 'click');
    expect(fake.starts()).toBe(1);
  });
});

describe('errors recover the panel rather than leaving it stuck (P1)', () => {
  it('routes a session error to the failure state and re-enables Play', () => {
    const host = createHost();
    const fake = createFakeSession();
    const panel = mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onError?.(new Error('match blew up'));

    expect(panel.state()).toBe('error');
    expect(host.node('[data-arcade-play]').disabled).toBe(false);
    expect(host.node('[data-arcade-status]').innerHTML).toContain('match blew up');
  });

  it('recovers from a synchronous throw when starting the set', () => {
    const host = createHost();
    const panel = mountArcadePanel(host, {
      runSession: () => {
        throw new Error('cannot start');
      },
    });

    host.fire('[data-arcade-play]', 'click');
    expect(panel.state()).toBe('error');
    expect(host.node('[data-arcade-play]').disabled).toBe(false);
  });

  it('does nothing on a keydown before a set has started (no session to feed)', () => {
    const host = createHost();
    mountArcadePanel(host, {});
    expect(() => host.fire('[data-arcade-keys]', 'keydown', { key: 'z' })).not.toThrow();
  });

  it('ignores a keydown event with no key at all', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });
    host.fire('[data-arcade-play]', 'click');
    expect(() => host.fire('[data-arcade-keys]', 'keydown', {})).not.toThrow();
    expect(fake.fed).toStrictEqual([]);
  });
});

describe('the key-capture div receives focus when a set starts (P3)', () => {
  it('calls .focus() on [data-arcade-keys] right when play() runs', () => {
    const host = createHost();
    const fake = createFakeSession();
    let focusCalls = 0;
    host.node('[data-arcade-keys]').focus = (): void => {
      focusCalls += 1;
    };

    mountArcadePanel(host, { runSession: fake.runSession });
    host.fire('[data-arcade-play]', 'click');

    expect(focusCalls).toBe(1);
  });

  it('never throws when the host node has no focus method', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });
    expect(() => host.fire('[data-arcade-play]', 'click')).not.toThrow();
  });
});

/**
 * Story 10.6, carried forward to the set: the affordance is a property of the
 * panel, driven by the session's `onLegalActions` the same way it was driven by
 * the Match's.
 */
describe('the panel tells the player the Ultimate is ready (Story 10.6, AC3)', () => {
  it('shows nothing before a set has started', () => {
    const host = createHost();
    mountArcadePanel(host, {});
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });

  it('surfaces the affordance the moment the gauge reports itself full', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');

    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block', 'special']);
    expect(host.node('[data-arcade-ultimate]').innerHTML).toContain('Ultimate ready');
    expect(host.node('[data-arcade-ultimate]').innerHTML).toContain('L');
  });

  it('clears it again when the bar is spent', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block', 'special']);
    expect(host.node('[data-arcade-ultimate]').innerHTML).not.toBe('');
    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block']);
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });

  it('clears it when the set ends', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block', 'special']);
    fake.config().onSetEnd?.(setEnd([2, 0], true, [logFor('p1'), logFor('p1')]));
    expect(host.node('[data-arcade-ultimate]').innerHTML).toBe('');
  });
});

describe('pressing L below a full gauge says why (Story 10.6, AC2)', () => {
  it('explains the drop, and still forwards the press so the Agent remains the one thing that drops it', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block']);
    host.fire('[data-arcade-keys]', 'keydown', { key: 'l' });

    expect(host.node('[data-arcade-status]').innerHTML).toContain('Ultimate not ready');
    expect(fake.fed).toStrictEqual(['l']);
  });

  it('says nothing of the sort when the gauge is full', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block', 'special']);
    host.fire('[data-arcade-keys]', 'keydown', { key: 'l' });

    expect(host.node('[data-arcade-status]').innerHTML).not.toContain('Ultimate not ready');
    expect(fake.fed).toStrictEqual(['l']);
  });

  it('gives the on-screen Special button the identical explanation', () => {
    const host = createHost();
    const fake = createFakeSession();
    mountArcadePanel(host, { runSession: fake.runSession });

    host.fire('[data-arcade-play]', 'click');
    fake.config().onLegalActions?.(['advance', 'retreat', 'attack', 'block']);
    host.fire('[data-arcade-action="special"]', 'click');

    expect(host.node('[data-arcade-status]').innerHTML).toContain('Ultimate not ready');
    expect(fake.fed).toStrictEqual(['special']);
  });
});

describe('the controls are documented where a player will read them (Story 10.6, AC5)', () => {
  it('names L in the panel’s own help text', () => {
    expect(arcadeMarkup()).toContain('L throws the Ultimate');
    expect(arcadeMarkup()).toContain('data-arcade-ultimate');
  });
});

/**
 * Story 12.2, carried forward: the live canvas is on screen and drawing the
 * instant the set's first Match reaches its reset state -- before any key.
 */
function createLiveHost(): FakePanelHost & {
  readonly canvasOps: () => readonly string[];
  readonly stageClass: () => string;
} {
  const base = createHost();
  const ops: string[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      void args;
      ops.push(op);
    };
  const context = new Proxy(
    {
      fillRect: record('fillRect'),
      strokeRect: record('strokeRect'),
      fillText: record('fillText'),
      clearRect: record('clearRect'),
      drawImage: record('drawImage'),
      save: record('save'),
      restore: record('restore'),
      translate: record('translate'),
      scale: record('scale'),
    } as Record<string, unknown>,
    {
      get: (target, key: string) => (key in target ? target[key] : ''),
      set: () => true,
    },
  );

  const stage = { className: '' };

  return {
    ...base,
    querySelector: (selector: string): ArcadeNode | null => {
      const node = base.node(selector);
      if (selector === 'canvas') {
        return { ...node, width: 0, height: 0, getContext: () => context } as unknown as ArcadeNode;
      }
      if (selector === '[data-arcade-stage]') {
        return {
          ...node,
          setAttribute: (_name: string, value: string): void => {
            stage.className = value;
          },
        } as unknown as ArcadeNode;
      }
      return node;
    },
    canvasOps: (): readonly string[] => ops,
    stageClass: (): string => stage.className,
  };
}

/** A view whose animation-frame queue this test does not pump: the first paint is synchronous. */
function createStubView(): HostView {
  return {
    requestAnimationFrame: (): number => 1,
    cancelAnimationFrame: (): void => undefined,
  };
}

describe('the live canvas draws the fight while it is played (Story 12.2)', () => {
  it('paints the fighters the instant Play runs, before the first key', () => {
    const host = createLiveHost();
    // No injected session: the real best-of-three runs, and its first Match's
    // reset state is reported synchronously by `runArcadeMatch`.
    mountArcadePanel(host, { view: createStubView(), seed: 4_601 });

    expect(host.canvasOps()).toHaveLength(0);
    expect(host.stageClass()).toBe('tb-arcade-stage');

    host.fire('[data-arcade-play]', 'click');

    expect(host.canvasOps()).toContain('clearRect');
    expect(host.canvasOps()).toContain('fillRect');
    expect(host.stageClass()).toBe('tb-arcade-stage tb-arcade-stage--live');
  });

  it('keeps its pre-12.2 behaviour when there is no view to drive a clock', () => {
    const host = createLiveHost();
    expect(() => mountArcadePanel(host, { seed: 4_601 })).not.toThrow();
    host.fire('[data-arcade-play]', 'click');
    expect(host.canvasOps()).toHaveLength(0);
    expect(host.stageClass()).toBe('tb-arcade-stage');
  });
});
