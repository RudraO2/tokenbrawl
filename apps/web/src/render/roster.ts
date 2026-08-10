import { ARENA_PALETTE } from './arena-palette';

/**
 * Story 11.4: the one place an `agentIndex` becomes a fighter.
 *
 * Until this story nothing in the render path knew *which character* a fighter
 * was. `startup.ts` fetched `/sprites/clawde/layout.json` for agent 0 and
 * `/sprites/chatty/layout.json` for agent 1, and that string was the only trace
 * of the roster anywhere -- so the aura in `arena-palette.ts` (keyed by fighter
 * id since 11.1) had no key to be looked up by, and the Ultimate's per-character
 * art would have had none either.
 *
 * That gap is exactly the shape of the Story 9.7 defect the epic context names:
 * four packs shipped, two wired, and nothing said so. A roster held in one
 * module and consumed by every surface that needs it -- the sprite URL, the
 * aura, the Ultimate art, the caster's name -- is what makes "wired" checkable:
 * `spriteLayoutUrlFor` and `ARENA_PALETTE.aura` now take the same key, so a
 * fighter drawn with clawde's sprites cannot glow in chatty's colour.
 *
 * ## Four ids, two in play
 *
 * `ROSTER_IDS` is the whole roster; `DEFAULT_ROSTER` is the pair a live Match
 * shows when nobody has chosen. Both are here rather than one being derived
 * from the other, because they answer different questions: the first is "what
 * art exists", the second is "who is fighting".
 *
 * ## Story 12.5: the choosing
 *
 * Character select landed, and it landed the way the paragraph above predicted
 * it would -- `createRosterSelection` replaces `DEFAULT_ROSTER` at its call
 * sites and nothing else here changed. `DEFAULT_ROSTER` stays, because it is
 * still the honest answer to "who is fighting" on a first load, a direct link
 * to a replay, and the hero raster: the pair used when nothing has been chosen.
 *
 * The selection is a factory with closure state rather than a module-level
 * binding, per house convention (`source-discipline.test.ts` bans the latter),
 * and it is *presentation only*. A character is a key into art. It appears in
 * no Command Log field and must never be added to one: the identity of a
 * fighter is its Agent, and two Deployments of the same model drawn as
 * different characters would make the log lie about who fought.
 *
 * No colour literal, no asset byte, no reference to the project this art came
 * from. The aura is read back out of `ARENA_PALETTE`, which stays the only
 * place an arena colour is written down.
 */

/** Every fighter this project has art for. Story 9.7's four-character roster. */
export const ROSTER_IDS = ['clawde', 'chatty', 'gemini', 'grokk'] as const;

export type RosterId = (typeof ROSTER_IDS)[number];

/** The two fighters on screen in a live Match, by agent index. */
export type RosterPair = readonly [RosterId, RosterId];

/**
 * The pair a Match is drawn with today.
 *
 * Named here rather than spelled into `startup.ts`'s sprite URLs, so that the
 * pack, the aura, the Ultimate art and the portrait are all keyed by one value
 * and cannot be changed in three places out of four.
 */
export const DEFAULT_ROSTER: RosterPair = Object.freeze(['clawde', 'chatty'] as const);

/**
 * The name drawn under a caster's portrait during the Ultimate.
 *
 * Uppercase because it is arcade type on the canvas rather than page copy --
 * the same treatment `hud.ts` gives `ULTIMATE READY` -- and a table rather than
 * `id.toUpperCase()` so a fighter whose display name is not its id has
 * somewhere to be written down.
 */
export const ROSTER_NAMES: Readonly<Record<RosterId, string>> = Object.freeze({
  clawde: 'CLAWDE',
  chatty: 'CHATTY',
  gemini: 'GEMINI',
  grokk: 'GROKK',
});

/**
 * Whether an arbitrary value names a fighter in this roster.
 *
 * Used at the layout boundary, where the id arrives as a key of a fetched JSON
 * document and is therefore untrusted: a document naming `ult_pilot_beam`
 * describes art this project did not ship, and admitting it would put an
 * unbound pose in a map every lookup then has to guard against.
 */
export function isRosterId(value: unknown): value is RosterId {
  return typeof value === 'string' && (ROSTER_IDS as readonly string[]).includes(value);
}

/** The fighter's own aura colour, which is what makes an Ultimate read as *whose*. */
export function auraFor(id: RosterId): string {
  return ARENA_PALETTE.aura[id];
}

/**
 * Where this fighter's sprite pack is described.
 *
 * The layouts already sit at `/sprites/<id>/layout.json`, one directory per
 * roster id, so this is the naming convention made explicit rather than a new
 * one -- and it is what stops the roster and the sprite URLs drifting apart.
 */
export function spriteLayoutUrlFor(id: RosterId): string {
  return `/sprites/${id}/layout.json`;
}

/**
 * The fighter's portrait, the same file the Ultimate cinematic already cuts to
 * (`/fx/ult-layout.json` names it per fighter).
 *
 * Story 12.5 draws it a second time, as an `<img>` on the character-select
 * screen. Deliberately the *same* asset rather than new art: four portraits
 * shipped in Story 9.7 and a select screen that invented its own would be that
 * story's defect -- art shipped, art unwired -- committed a second time.
 */
export function portraitUrlFor(id: RosterId): string {
  return `/portraits/${id}.png`;
}

/** Which fighter a side of the Match is drawn as. `0` is the visitor, `1` the opponent. */
export type RosterSide = 0 | 1;

/**
 * The pair a live Match is drawn with, and the ability to change it.
 *
 * Read through `pair()` at every draw rather than captured once, because the
 * visitor can choose again between Matches and a surface holding a stale
 * snapshot would draw the previous choice for the rest of the session -- the
 * same failure mode `startup.ts`'s dressing boxes exist to prevent.
 */
export interface RosterSelection {
  /** Who is fighting right now. `DEFAULT_ROSTER` until something is chosen. */
  readonly pair: () => RosterPair;
  /** Puts `id` on `side`. A no-op when that side already carries it. */
  readonly select: (side: RosterSide, id: RosterId) => void;
}

export interface RosterSelectionDeps {
  /** The pair before anything is chosen. `DEFAULT_ROSTER` unless a test says otherwise. */
  readonly initial?: RosterPair;
  /**
   * Called with the new pair after every change that is a change.
   *
   * This is how a choice reaches the sprite packs: `startup.ts` fetches the
   * chosen fighters' layouts and the Ultimate art keyed by them. Not called on a
   * no-op re-selection, so picking the fighter you already have does not
   * re-fetch a megabyte of art.
   */
  readonly onChange?: (pair: RosterPair) => void;
}

export function createRosterSelection(deps: RosterSelectionDeps = {}): RosterSelection {
  // Closure state in a factory, never a module-level binding.
  const state: { pair: RosterPair } = { pair: deps.initial ?? DEFAULT_ROSTER };
  return Object.freeze({
    pair: (): RosterPair => state.pair,
    select: (side: RosterSide, id: RosterId): void => {
      if (state.pair[side] === id) {
        return;
      }
      state.pair = Object.freeze(
        side === 0 ? ([id, state.pair[1]] as const) : ([state.pair[0], id] as const),
      );
      deps.onChange?.(state.pair);
    },
  });
}
