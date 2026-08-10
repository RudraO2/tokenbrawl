import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROSTER,
  ROSTER_IDS,
  ROSTER_NAMES,
  createRosterSelection,
  portraitUrlFor,
  type RosterId,
  type RosterSide,
} from '../render/roster';
import { mountSelectPanel, selectMarkup, type SelectKeyEvent, type SelectNode } from './select';

/**
 * Story 12.5: the screen that makes four fighters four fighters.
 *
 * The DOM here is a recording fake rather than jsdom, matching every other panel
 * suite in this app: `tsconfig.base.json` has no DOM lib and the panels are all
 * written against structural shapes precisely so their wiring can be driven with
 * no browser. What a browser is needed for -- that a visitor can *see* four
 * portraits and that picking one changes what is drawn -- is the visual gate's
 * `character-select-reachable` and `selected-fighter-is-drawn`, not this file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = readFileSync(join(HERE, '..', 'styles', 'app.css'), 'utf8');

interface FakeNode extends SelectNode {
  readonly attributes: Map<string, string>;
  readonly listeners: Map<string, ((event?: SelectKeyEvent) => void)[]>;
  readonly focused: { count: number };
  click(): void;
  press(key: string, prevented: { value: boolean }): void;
}

function fakeNode(): FakeNode {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((event?: SelectKeyEvent) => void)[]>();
  const focused = { count: 0 };
  const fire = (type: string, event?: SelectKeyEvent): void => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
    }
  };
  return {
    innerHTML: '',
    attributes,
    listeners,
    focused,
    setAttribute: (name, value): void => {
      attributes.set(name, value);
    },
    removeAttribute: (name): void => {
      attributes.delete(name);
    },
    addEventListener: (type, listener): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    focus: (): void => {
      focused.count += 1;
    },
    click: (): void => {
      fire('click');
    },
    press: (key, prevented): void => {
      fire('keydown', {
        key,
        preventDefault: (): void => {
          prevented.value = true;
        },
      });
    },
  };
}

const cardSelectorFor = (side: RosterSide, id: RosterId): string =>
  `[data-select-pick="${String(side)}:${id}"]`;

/**
 * A host that answers only for the selectors the screen's own markup declares,
 * and `null` for everything else.
 *
 * The `null` matters more than it looks. A fake that manufactured a node for any
 * string would answer a *typo'd* selector just as happily as a correct one, so
 * every case in this file would pass over a panel whose click handlers were
 * bound to elements that do not exist on the page -- which is the same class of
 * defect as a roster wired to nothing, one layer down. `missing` drops a
 * selector so the mount's own failure path can be driven.
 */
function fakeHost(missing: readonly string[] = []): {
  innerHTML: string;
  querySelector: (s: string) => FakeNode | null;
  nodes: Map<string, FakeNode>;
} {
  const declared = [
    ...[0, 1].flatMap((side) => ROSTER_IDS.map((id) => `[data-select-pick="${String(side)}:${id}"]`)),
    '[data-select-fight]',
    '[data-select-readout]',
  ].filter((selector) => !missing.includes(selector));
  const nodes = new Map<string, FakeNode>();
  return {
    innerHTML: '',
    nodes,
    querySelector: (selectors: string): FakeNode | null => {
      if (!declared.includes(selectors)) {
        return null;
      }
      const existing = nodes.get(selectors);
      if (existing !== undefined) {
        return existing;
      }
      const node = fakeNode();
      nodes.set(selectors, node);
      return node;
    },
  };
}

/** The cards this suite drives are always present; the `null` arm is its own case below. */
const card = (
  host: ReturnType<typeof fakeHost>,
  side: RosterSide,
  id: RosterId,
): FakeNode => {
  const node = host.querySelector(cardSelectorFor(side, id));
  if (node === null) {
    throw new Error(`the fake host declares no card for ${String(side)}:${id}`);
  }
  return node;
};



describe('the character-select screen offers all four fighters', () => {
  it('names every fighter and shows every portrait', () => {
    const markup = selectMarkup();
    for (const id of ROSTER_IDS) {
      // The name plate and the portrait, per fighter, on both sides -- the
      // whole defect this story closes is that two of these four appeared
      // nowhere a visitor could reach.
      expect(markup).toContain(ROSTER_NAMES[id]);
      expect(markup).toContain(portraitUrlFor(id));
    }
  });

  it('offers each fighter for both sides, because both are drawn', () => {
    const markup = selectMarkup();
    for (const side of [0, 1] as const) {
      for (const id of ROSTER_IDS) {
        expect(markup).toContain(`data-select-pick="${String(side)}:${id}"`);
      }
    }
  });

  it('marks the chosen fighter on each side, and only that one', () => {
    const host = fakeHost();
    const selection = createRosterSelection();
    mountSelectPanel(host, { pair: () => selection.pair(), onPick: () => {}, onFight: () => {} });

    for (const side of [0, 1] as const) {
      for (const id of ROSTER_IDS) {
        expect(card(host, side, id).attributes.get('aria-pressed')).toBe(
          selection.pair()[side] === id ? 'true' : 'false',
        );
      }
    }
  });

  it('sends a click through to the selection and re-marks the screen', () => {
    const host = fakeHost();
    const picks: [RosterSide, RosterId][] = [];
    const selection = createRosterSelection();
    mountSelectPanel(host, {
      pair: () => selection.pair(),
      onPick: (side, id) => {
        picks.push([side, id]);
        selection.select(side, id);
      },
      onFight: () => {},
    });

    card(host, 0, 'gemini').click();
    card(host, 1, 'grokk').click();

    expect(picks).toStrictEqual([
      [0, 'gemini'],
      [1, 'grokk'],
    ]);
    expect(selection.pair()).toStrictEqual(['gemini', 'grokk']);
    expect(card(host, 0, 'gemini').attributes.get('aria-pressed')).toBe(
      'true',
    );
    expect(card(host, 0, DEFAULT_ROSTER[0]).attributes.get('aria-pressed')).toBe(
      'false',
    );
  });

  it('reaches all four fighters with the arrow keys and confirms without a pointer', () => {
    // The keyboard criterion, driven the way a keyboard drives it. The cards
    // are `<button>`s, so Enter is the platform's job; what this story added is
    // the arcade traversal on top, and a roster a keyboard could only tab
    // through would still satisfy the letter of the criterion while feeling
    // like a form.
    const host = fakeHost();
    const selection = createRosterSelection();
    const fights = { count: 0 };
    mountSelectPanel(host, {
      pair: () => selection.pair(),
      onPick: (side, id) => {
        selection.select(side, id);
      },
      onFight: () => {
        fights.count += 1;
      },
    });

    const prevented = { value: false };
    // From the first card, three ArrowRights reach the fourth fighter: one
    // focus call each, and the last one is grokk's card.
    card(host, 0, ROSTER_IDS[0]).press('ArrowRight', prevented);
    expect(card(host, 0, ROSTER_IDS[1]).focused.count).toBe(1);
    card(host, 0, ROSTER_IDS[1]).press('ArrowRight', prevented);
    card(host, 0, ROSTER_IDS[2]).press('ArrowRight', prevented);
    expect(card(host, 0, ROSTER_IDS[3]).focused.count).toBe(1);
    // And the page does not scroll out from under them while they do it.
    expect(prevented.value).toBe(true);

    // Down moves to the same column on the opponent's row.
    card(host, 0, ROSTER_IDS[3]).press('ArrowDown', prevented);
    expect(card(host, 1, ROSTER_IDS[3]).focused.count).toBe(1);

    // Clamped, not wrapped, at both ends: no focus call beyond the edge.
    const first = card(host, 0, ROSTER_IDS[0]);
    first.press('ArrowLeft', prevented);
    expect(first.focused.count).toBe(1);

    // Confirming is a click on the Fight button, which is what Enter on a
    // focused `<button>` dispatches.
    host.querySelector('[data-select-fight]')?.click();
    expect(fights.count).toBe(1);
  });

  it('says who is fighting, for a reader who cannot see the marks', () => {
    const host = fakeHost();
    const selection = createRosterSelection();
    mountSelectPanel(host, {
      pair: () => selection.pair(),
      onPick: (side, id) => {
        selection.select(side, id);
      },
      onFight: () => {},
    });
    card(host, 0, 'grokk').click();
    expect(host.querySelector('[data-select-readout]')?.innerHTML).toContain(ROSTER_NAMES.grokk);
  });

  it('throws rather than mounting half a screen when the Fight button is missing', () => {
    // `startup.ts` catches this and warns, exactly as it does for every other
    // panel: the roster is an offer and the replay is the page's claim. What
    // must not happen is a screen that mounts, marks cards, and can never start
    // a Match -- a dead end with no error anywhere.
    expect(() =>
      mountSelectPanel(fakeHost(['[data-select-fight]']), {
        pair: () => DEFAULT_ROSTER,
        onPick: () => {},
        onFight: () => {},
      }),
    ).toThrow(/did not mount/);
  });

  it('still mounts when the readout is missing, because it is narration', () => {
    // The asymmetry is the point: a missing Fight button is a dead end, a
    // missing readout is one sentence a sighted visitor can read off the cards.
    expect(() =>
      mountSelectPanel(fakeHost(['[data-select-readout]']), {
        pair: () => DEFAULT_ROSTER,
        onPick: () => {},
        onFight: () => {},
      }),
    ).not.toThrow();
  });

  it('gives the cards the focus ring docs/DESIGN.md requires', () => {
    // Page chrome keeps every rule: a 3px `--tb-accent` outline on focus, and
    // no rounded corner or gradient anywhere near a portrait.
    expect(APP_CSS).toMatch(/\.tb-select-card:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--tb-accent\)/);
  });

  it('lays the roster out in a grid whose columns can actually shrink', () => {
    // `minmax(0, 1fr)` rather than `1fr`: a grid item's default `min-width` is
    // its content, and the content is a 512px portrait, so plain `1fr` columns
    // refuse to shrink and the 390px viewport scrolls sideways again -- the
    // defect Story 12.4 had just cleared, reintroduced by the obvious layout.
    expect(APP_CSS).toMatch(/\.tb-select-row\s*\{[^}]*minmax\(0, 1fr\)/);
    expect(APP_CSS).toMatch(/\.tb-select-portrait\s*\{[^}]*width:\s*100%/);
  });
});
