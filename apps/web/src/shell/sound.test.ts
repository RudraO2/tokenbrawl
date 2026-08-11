import { describe, expect, it } from 'vitest';
import { mountSoundControl, soundMarkup, type SoundHost, type SoundNode } from './sound';

/**
 * Story 12.9: the page's sound switch.
 *
 * Three claims, and all three are acceptance criteria: it reads ON on a first
 * load, a visitor's choice survives a reload, and the announced state and the
 * visible state are the same state. The last one is why every case here reads
 * `aria-pressed` rather than the label -- a button whose text said "Sound: on"
 * while its attribute said otherwise would pass a label-only test and fail a
 * screen reader.
 */

function createNode(): SoundNode & {
  readonly attributes: Map<string, string>;
  readonly click: () => void;
} {
  const attributes = new Map<string, string>();
  const listeners: (() => void)[] = [];
  return {
    innerHTML: '',
    setAttribute: (name: string, value: string): void => {
      attributes.set(name, value);
    },
    addEventListener: (_type: 'click', listener: () => void): void => {
      listeners.push(listener);
    },
    attributes,
    click: (): void => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function createHost(): SoundHost & { readonly button: ReturnType<typeof createNode> } {
  const button = createNode();
  return {
    innerHTML: '',
    querySelector: (selectors: string): SoundNode | null =>
      selectors === '[data-sound]' ? button : null,
    button,
  };
}

/** A `localStorage` that is a Map, and one that is not there at all. */
function createStorage(seed: Record<string, string> = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value);
    },
    entries,
  };
}

describe('the sound switch reads ON on a first load (AC1)', () => {
  it('mounts pressed, with the on label, when nothing has been remembered', () => {
    const host = createHost();
    const control = mountSoundControl(host, { storage: createStorage() });

    expect(control.enabled()).toBe(true);
    expect(host.button.innerHTML).toBe('Sound: on');
    // The markup itself, not only the state written afterwards: a control that
    // shipped `aria-pressed="false"` and corrected itself a line later would
    // announce the wrong thing to anything reading the document as it arrives.
    expect(soundMarkup(true)).toContain('aria-pressed="true"');
    expect(soundMarkup(false)).toContain('aria-pressed="false"');
  });

  it('reads ON with no storage at all, which is a blocked tab', () => {
    expect(mountSoundControl(createHost()).enabled()).toBe(true);
  });

  it('reads ON when storage throws, rather than failing to mount', () => {
    // `localStorage` throws on *access* in a tab with third-party storage
    // blocked. The default is what a broken read has to land on.
    const host = createHost();
    const control = mountSoundControl(host, {
      storage: {
        getItem: (): string | null => {
          throw new Error('storage is blocked in this context');
        },
        setItem: (): void => {
          throw new Error('storage is blocked in this context');
        },
      },
    });

    expect(control.enabled()).toBe(true);
    expect(() => {
      control.set(false);
    }).not.toThrow();
    expect(control.enabled()).toBe(false);
  });
});

describe('a visitor who turns it off keeps it off (AC3)', () => {
  it('round-trips the choice through storage', () => {
    const storage = createStorage();
    mountSoundControl(createHost(), { storage }).set(false);

    // A second mount is a reload: same storage, new control.
    const reloaded = mountSoundControl(createHost(), { storage });
    expect(reloaded.enabled()).toBe(false);
    expect(reloaded.set).toBeTypeOf('function');

    reloaded.set(true);
    expect(mountSoundControl(createHost(), { storage }).enabled()).toBe(true);
  });

  it('treats only the off value as off, so a corrupted entry reads as on', () => {
    // The direction a broken read should fail in: on is the default, and a
    // half-written or foreign value must not mute a page silently.
    for (const stored of ['', 'nonsense', 'true', 'ON']) {
      const storage = createStorage({ 'tokenbrawl.sound': stored });
      expect(mountSoundControl(createHost(), { storage }).enabled()).toBe(true);
    }
    expect(
      mountSoundControl(createHost(), {
        storage: createStorage({ 'tokenbrawl.sound': 'off' }),
      }).enabled(),
    ).toBe(false);
  });
});

describe('the switch is one control with one state', () => {
  it('flips on a click, and moves the label and the attribute together', () => {
    const host = createHost();
    const seen: boolean[] = [];
    const control = mountSoundControl(host, {
      storage: createStorage(),
      onChange: (enabled) => seen.push(enabled),
    });

    host.button.click();
    expect(control.enabled()).toBe(false);
    expect(host.button.innerHTML).toBe('Sound: off');
    expect(host.button.attributes.get('aria-pressed')).toBe('false');

    host.button.click();
    expect(control.enabled()).toBe(true);
    expect(host.button.innerHTML).toBe('Sound: on');
    expect(host.button.attributes.get('aria-pressed')).toBe('true');
    expect(seen).toStrictEqual([false, true]);
  });

  it('reports nothing when set to what it already reads', () => {
    // What makes the two-way sync with Spectate's own button terminate: this
    // control tells the panel, the panel tells this control, and the second hop
    // is a no-op rather than a loop.
    const seen: boolean[] = [];
    const control = mountSoundControl(createHost(), {
      storage: createStorage(),
      onChange: (enabled) => seen.push(enabled),
    });

    control.set(true);
    expect(seen).toStrictEqual([]);
    control.set(false);
    control.set(false);
    expect(seen).toStrictEqual([false]);
  });

  it('throws when the control has nowhere to mount, rather than reporting a switch that is not there', () => {
    expect(() => {
      mountSoundControl({ innerHTML: '', querySelector: (): SoundNode | null => null });
    }).toThrow(/did not mount/);
  });
});
