import { escapeHtml } from '../main';
import {
  ROSTER_IDS,
  ROSTER_NAMES,
  portraitUrlFor,
  type RosterId,
  type RosterPair,
  type RosterSide,
} from '../render/roster';

/**
 * Story 12.5: the character-select screen.
 *
 * The third time this defect was written down. Story 9.7 is *titled*
 * "four-character custom roster" and shipped four sprite packs while wiring
 * two; Story 10.1 listed it as one of the three Epic 9 defects that shipped
 * green; Story 11.4 built `render/roster.ts` around the gap and recorded it in
 * that module's own docblock. `ROSTER_IDS`, `ROSTER_NAMES`, `ARENA_PALETTE.aura`
 * and `spriteLayoutUrlFor` all already named four fighters. The screen was the
 * only missing piece, and this is it.
 *
 * ## Two picks, not one
 *
 * An arcade Match is human-versus-bot and *both* sides are drawn, so both are
 * chosen. Spectate is untouched -- its entries are fixed by their committed
 * logs -- and so is the replay player, which draws whichever pair its log names.
 *
 * ## The portraits are the assets, and that is the point
 *
 * `apps/web/public/portraits/*.png` ship today and are already cut into the
 * Ultimate cinematic (`/fx/ult-layout.json` names one per fighter). Drawing them
 * here is a second use of a committed asset rather than an invitation to draw
 * new art -- which is exactly the Story 9.7 failure this screen exists to close.
 *
 * ## Page chrome, not the arena
 *
 * `docs/DESIGN.md`'s "Two regimes": the arena's release from the flat-surface
 * rules covers `apps/web/src/render/**\/*.ts` only. This file is chrome and
 * keeps every rule -- flat fills, square corners, ink borders, the hard offset
 * shadow, press-displaces, stepped motion. A portrait is an `<img>` in a
 * bordered box, never a glowing card.
 *
 * Every DOM type here is structural, per house convention: `tsconfig.base.json`
 * has no DOM lib and must not gain one (see `byok/panel.ts`'s docblock for why).
 */

export type SelectEvent = 'click' | 'keydown';

export interface SelectKeyEvent {
  readonly key?: string;
  /**
   * Optional because a test fake has no reason to implement it, and because the
   * arrow keys this screen binds would otherwise scroll the page out from under
   * a keyboard visitor moving across the roster.
   */
  preventDefault?(): void;
}

export interface SelectNode {
  innerHTML: string;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  addEventListener(type: SelectEvent, listener: (event?: SelectKeyEvent) => void): void;
  focus?(): void;
}

export interface SelectHost {
  innerHTML: string;
  querySelector(selectors: string): SelectNode | null;
}

export interface SelectPanelDeps {
  /** The pair showing when the screen mounts, so a re-visit shows what was chosen. */
  readonly pair: () => RosterPair;
  /** Records a pick. `startup.ts` fetches that fighter's art on the way through. */
  readonly onPick: (side: RosterSide, id: RosterId) => void;
  /**
   * The visitor is done choosing: start the Match.
   *
   * Kept as a callback rather than an `ArcadePanel` import for the reason the
   * landing CTAs are callbacks -- this screen must not learn what a Match is.
   */
  readonly onFight: () => void;
}

export interface SelectPanel {
  /** Re-marks the cards from the current pair. Called after every pick. */
  readonly refresh: () => void;
  /** The pair the screen is currently showing as chosen. For tests and the readout. */
  readonly shown: () => RosterPair;
}

/** Which side of the Match each row chooses for, and what the row is called. */
const SIDES: readonly { readonly side: RosterSide; readonly heading: string }[] = [
  { side: 0, heading: 'You' },
  { side: 1, heading: 'Opponent' },
];

/** The attribute a card carries its `side:id` in, so one delegated lookup finds any of the eight. */
const PICK_ATTRIBUTE = 'data-select-pick';

const cardId = (side: RosterSide, id: RosterId): string => `${String(side)}:${id}`;

function cardMarkup(side: RosterSide, id: RosterId, heading: string): string {
  const name = ROSTER_NAMES[id];
  return `
    <button
      class="tb-select-card"
      type="button"
      ${PICK_ATTRIBUTE}="${escapeHtml(cardId(side, id))}"
      aria-pressed="false"
      aria-label="${escapeHtml(`${name} for ${heading}`)}"
    >
      <img class="tb-select-portrait" src="${escapeHtml(portraitUrlFor(id))}" alt="" />
      <span class="tb-select-plate">${escapeHtml(name)}</span>
    </button>
  `;
}

/**
 * The screen's markup. Exported so it can be asserted with no DOM, in exactly
 * the spirit of `arcadeMarkup`/`navMarkup`.
 *
 * The heading and the two row headings are real headings rather than styled
 * paragraphs: this screen is where a keyboard visitor arrives with no canvas to
 * look at, and the structure is the only thing telling them the eight cards are
 * two choices rather than one row of eight.
 */
export function selectMarkup(): string {
  const rows = SIDES.map(
    ({ side, heading }) => `
      <div class="tb-select-side">
        <h3 class="tb-select-side-heading" id="tb-select-side-${String(side)}">${escapeHtml(heading)}</h3>
        <div class="tb-select-row" role="group" aria-labelledby="tb-select-side-${String(side)}">
          ${ROSTER_IDS.map((id) => cardMarkup(side, id, heading)).join('')}
        </div>
      </div>
    `,
  ).join('');
  return `
    <h2 class="tb-select-heading">Characters</h2>
    <p class="tb-select-note">
      Four fighters, four sprite packs, four portraits &mdash; all of it shipped, and until now only
      two of them reachable. Pick who you play and who you play against, then fight. Arrow keys move
      across the roster; Enter chooses. Who you pick changes what is drawn, never what is simulated.
    </p>
    ${rows}
    <button class="tb-button tb-select-fight" type="button" data-select-fight>Fight</button>
    <p class="tb-select-readout" data-select-readout role="status" aria-live="polite"></p>
  `;
}

/**
 * Mounts the screen and wires it.
 *
 * The cards are `<button>`s, so the keyboard reaches all eight with no
 * `tabindex` of our own and Enter confirms with no key handler at all. The
 * arrow keys are added on top of that rather than in place of it: they are the
 * arcade gesture, and a screen that *only* answered to them would be a roster
 * a `Tab` key could not cross.
 */
export function mountSelectPanel(host: SelectHost, deps: SelectPanelDeps): SelectPanel {
  host.innerHTML = selectMarkup();

  const fightNode = host.querySelector('[data-select-fight]');
  const readoutNode = host.querySelector('[data-select-readout]');
  if (fightNode === null) {
    throw new Error('mountSelectPanel: the screen did not mount.');
  }

  /**
   * The eight cards, by side, in roster order.
   *
   * Collected once at mount rather than looked up per keystroke, because arrow
   * traversal needs the *order* as much as the nodes: "the next fighter" is a
   * position in this array, and a fresh `querySelectorAll` each time would be
   * the same list rebuilt to answer the same question.
   */
  const cards: readonly (readonly (SelectNode | null)[])[] = SIDES.map(({ side }) =>
    ROSTER_IDS.map((id) => host.querySelector(`[${PICK_ATTRIBUTE}="${cardId(side, id)}"]`)),
  );

  const say = (pair: RosterPair): void => {
    if (readoutNode === null) {
      return;
    }
    readoutNode.innerHTML = escapeHtml(
      `${ROSTER_NAMES[pair[0]]} versus ${ROSTER_NAMES[pair[1]]}. Press Fight to start.`,
    );
  };

  /**
   * Marks the chosen card on each side.
   *
   * `aria-pressed` is the state rather than a class alone, for the reason
   * `nav.ts` uses `aria-current`: "which fighter am I playing" is exactly the
   * question a screen-reader user cannot answer from a lime border. The
   * stylesheet keys off the same attribute, so the visible state and the
   * announced state cannot drift.
   */
  const refresh = (): void => {
    const pair = deps.pair();
    SIDES.forEach(({ side }) => {
      ROSTER_IDS.forEach((id, index) => {
        cards[side][index]?.setAttribute?.('aria-pressed', pair[side] === id ? 'true' : 'false');
      });
    });
    say(pair);
  };

  /** Moves focus by `step` cards within a row, or to the same column on the other side. */
  const move = (side: RosterSide, index: number, key: string): boolean => {
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const next = index + (key === 'ArrowRight' ? 1 : -1);
      // Clamped rather than wrapped: a roster that jumps from the last fighter
      // back to the first gives a keyboard visitor no way to feel where its
      // edges are, and there are four of them, not forty.
      const clamped = Math.max(0, Math.min(next, ROSTER_IDS.length - 1));
      cards[side][clamped]?.focus?.();
      return true;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const other: RosterSide = side === 0 ? 1 : 0;
      cards[other][index]?.focus?.();
      return true;
    }
    return false;
  };

  SIDES.forEach(({ side }) => {
    ROSTER_IDS.forEach((id, index) => {
      const node = cards[side][index];
      if (node === null || node === undefined) {
        return;
      }
      node.addEventListener('click', () => {
        deps.onPick(side, id);
        refresh();
      });
      node.addEventListener('keydown', (event) => {
        const key = event?.key;
        if (key === undefined) {
          return;
        }
        if (move(side, index, key)) {
          // Arrow keys scroll a page by default, and a roster that scrolled the
          // screen away while the visitor crossed it would be worse than one
          // with no arrow keys at all.
          event?.preventDefault?.();
        }
      });
    });
  });

  fightNode.addEventListener('click', () => {
    deps.onFight();
  });

  refresh();

  return Object.freeze({
    refresh,
    shown: (): RosterPair => deps.pair(),
  });
}
