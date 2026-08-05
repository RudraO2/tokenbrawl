import { describe, expect, it } from 'vitest';
import type { CommandLogV2 } from '@tokenbrawl/contracts';
import { runArcadeMatch } from './run';
import {
  arcadeMarkup,
  mountArcadePanel,
  type ArcadeHost,
  type ArcadeKeyEvent,
  type ArcadeNode,
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
