import { describe, expect, it } from 'vitest';
import { mountPlayPanel, playMarkup, type PlayHost, type PlayNode } from './panel';
import { cabinetLaunchUrl } from './roster';

/**
 * The Play cabinet, asserted without a DOM: a fake host whose nodes remember
 * their attributes and listeners, a fake storage, and a fake frame whose
 * `contentWindow` records every message the page sends in.
 */

interface FakeHost extends PlayHost {
  readonly fire: (selector: string, type: 'click' | 'load') => void;
  readonly node: (selector: string) => PlayNode & { readonly attributes: Map<string, string> };
  readonly sent: () => readonly unknown[];
}

function createHost(): FakeHost {
  const nodes = new Map<string, PlayNode & { readonly attributes: Map<string, string> }>();
  const listeners = new Map<string, (() => void)[]>();
  const state = { html: '' };
  const sent: unknown[] = [];

  const child = (selector: string): PlayNode & { readonly attributes: Map<string, string> } => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const attributes = new Map<string, string>();
    const node: PlayNode & { readonly attributes: Map<string, string> } = {
      innerHTML: '',
      attributes,
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
      addEventListener: (type, listener): void => {
        const key = `${selector}:${type}`;
        listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      },
      contentWindow: {
        postMessage: (message: unknown) => {
          sent.push(message);
        },
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
    querySelector: (selector: string): PlayNode | null => child(selector),
    querySelectorAll: (selector: string): readonly PlayNode[] => {
      // The segmented controls are the only multi-node query; answer with one
      // node per option, in option order, exactly as the DOM would.
      const count = selector.includes('cpu') || selector.includes('rounds') ? 3 : 0;
      return Array.from({ length: count }, (_, index) => child(`${selector}#${String(index)}`));
    },
    fire: (selector, type): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener();
      }
    },
    node: (selector) => child(selector),
    sent: () => sent,
  };
}

function createStorage(seed: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('the Play cabinet', () => {
  it('starts in attract mode with the coin slot showing and no frame loaded', () => {
    const host = createHost();
    const panel = mountPlayPanel(host);
    expect(panel.state()).toBe('attract');
    expect(host.innerHTML).toContain('Insert coin');
    expect(host.node('[data-play-frame]').src).toBeUndefined();
    expect(panel.launch()).toStrictEqual({ cpu: 2, rounds: 3 });
  });

  it('boots the arena into duel mode on the coin, with the chosen settings', () => {
    const host = createHost();
    const panel = mountPlayPanel(host);
    host.fire('[data-play-frame]#1', 'click'); // rounds: best of 3 is index 1; cpu index 1 is normal
    host.fire('[data-play-start]', 'click');
    expect(panel.state()).toBe('booting');
    expect(host.node('[data-play-frame]').src).toBe(cabinetLaunchUrl({ cpu: 2, rounds: 3 }));
    expect(host.node('[data-play-attract]').hidden).toBe(true);
  });

  it('lands on a chosen fighter when the gallery asks for one', () => {
    const host = createHost();
    const panel = mountPlayPanel(host);
    panel.start('seeker');
    expect(host.node('[data-play-frame]').src).toBe(cabinetLaunchUrl({ cpu: 2, rounds: 3, p1: 'seeker' }));
  });

  it('remembers difficulty and rounds, and reads them back on the next mount', () => {
    const storage = createStorage();
    const host = createHost();
    mountPlayPanel(host, { storage });
    host.fire('[data-play-cpu]#2', 'click');
    host.fire('[data-play-rounds]#2', 'click');
    expect(JSON.parse(storage.getItem('tokenbrawl.play.settings') ?? '{}')).toStrictEqual({ cpu: 3, rounds: 5 });

    const again = mountPlayPanel(createHost(), { storage });
    expect(again.launch()).toStrictEqual({ cpu: 3, rounds: 5 });
  });

  it('ignores a corrupt or out-of-range setting rather than launching with it', () => {
    const storage = createStorage({ 'tokenbrawl.play.settings': '{"cpu":9,"rounds":"x"}' });
    expect(mountPlayPanel(createHost(), { storage }).launch()).toStrictEqual({ cpu: 2, rounds: 3 });
    const broken = createStorage({ 'tokenbrawl.play.settings': 'not json' });
    expect(mountPlayPanel(createHost(), { storage: broken }).launch()).toStrictEqual({ cpu: 2, rounds: 3 });
  });

  it('tells the arena whether sound is on the moment it reports ready', () => {
    const host = createHost();
    const panel = mountPlayPanel(host, { soundEnabled: () => false });
    panel.receive({ source: 'tb-arena', type: 'ready' });
    expect(host.sent()).toStrictEqual([{ source: 'tb-host', type: 'sound', enabled: false }]);
    panel.setSound(true);
    expect(host.sent().at(-1)).toStrictEqual({ source: 'tb-host', type: 'sound', enabled: true });
    panel.pause();
    expect(host.sent().at(-1)).toStrictEqual({ source: 'tb-host', type: 'pause' });
  });

  it('follows the arena from select to fight to result, and keeps a record', () => {
    const storage = createStorage();
    const host = createHost();
    const panel = mountPlayPanel(host, { storage });
    host.fire('[data-play-start]', 'click');
    panel.receive({ source: 'tb-arena', type: 'screen', screen: 'select' });
    expect(panel.state()).toBe('select');
    panel.receive({ source: 'tb-arena', type: 'screen', screen: 'fight' });
    expect(panel.state()).toBe('fighting');
    expect(host.node('[data-play-cabinet]').attributes.get('class')).toContain('tb-cabinet--live');

    panel.receive({ source: 'tb-arena', type: 'result', p1: 'clawde', p2: 'grokk', wins: [1, 2], winner: 2 });
    expect(panel.state()).toBe('result');
    expect(panel.record()).toStrictEqual({ wins: 0, losses: 1 });
    expect(host.node('[data-play-status]').innerHTML).toContain('You lose, 1-2');
    expect(host.node('[data-play-status]').innerHTML).toContain('Grok');
    expect(JSON.parse(storage.getItem('tokenbrawl.play.record') ?? '{}')).toStrictEqual({ wins: 0, losses: 1 });

    panel.receive({ source: 'tb-arena', type: 'result', p1: 'clawde', p2: 'grokk', wins: [2, 0], winner: 1 });
    expect(panel.record()).toStrictEqual({ wins: 1, losses: 1 });
    expect(host.node('[data-play-losses]').innerHTML).toBe('L 1');
    expect(host.node('[data-play-wins]').innerHTML).toBe('W 1');
  });

  it('ignores messages that are not from the arena', () => {
    const host = createHost();
    const panel = mountPlayPanel(host);
    host.fire('[data-play-start]', 'click');
    for (const message of [null, undefined, 1, 'x', {}, { source: 'evil', type: 'result', winner: 1 }]) {
      panel.receive(message);
    }
    expect(panel.state()).toBe('booting');
    expect(panel.record()).toStrictEqual({ wins: 0, losses: 0 });
  });

  it('quits back to attract mode and unloads the frame', () => {
    const host = createHost();
    const panel = mountPlayPanel(host);
    host.fire('[data-play-start]', 'click');
    panel.quit();
    expect(panel.state()).toBe('attract');
    expect(host.node('[data-play-frame]').src).toBe('about:blank');
    expect(host.node('[data-play-attract]').hidden).toBe(false);
  });

  it('throws rather than mounting half a cabinet', () => {
    const broken: PlayHost = { innerHTML: '', querySelector: () => null };
    expect(() => mountPlayPanel(broken)).toThrow(/did not mount/);
  });

  it('prints the keyboard map with the Ultimate on its own gold key', () => {
    const markup = playMarkup();
    for (const key of ['A', 'D', 'W', 'S', 'F', 'G', 'H', 'J', 'K', 'L', 'Enter']) {
      expect(markup).toContain(`>${key}</kbd>`);
    }
    expect(markup).toContain('tb-key--gold">L</kbd>');
  });
});
