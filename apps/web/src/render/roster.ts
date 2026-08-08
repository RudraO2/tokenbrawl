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
 * actually shows. Both are here rather than one being derived from the other,
 * because they answer different questions: the first is "what art exists", the
 * second is "who is fighting". Character select is still absent (the epic
 * context records it as a known gap), and when it lands it replaces
 * `DEFAULT_ROSTER` at its call sites without touching anything else.
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
