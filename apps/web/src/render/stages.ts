/**
 * Story 12.10: the one place a stage becomes art.
 *
 * The shape of `render/roster.ts`, for the shape of its problem. Until this
 * story the whole of the project's scenery was one backdrop, hard-coded into
 * `startup.ts` as a single URL. Six stages ship now, and a list held in one
 * module -- consumed by the loader, the character-select picker, the hero raster
 * and the visual gate alike -- is what makes "wired" checkable: a stage added
 * here and left without a card, or a card wired to nothing, is a drift the gate
 * and the tests can both see from their own side.
 *
 * ## Presentation only
 *
 * A stage is a key into art. It appears in **no** Command Log field and must
 * never be added to one: a replay draws the same scenery wherever it is played
 * because the stage is derived from the log's own `seed` (`stageForSeed`), not
 * recorded beside it. Two Matches on the same seed draw the same stage; nothing
 * a stage does can move a Final-State Hash (AD-15).
 *
 * No asset byte, no colour, no reference to the project the art came from lives
 * here -- the images and their dim are `public/stages/<id>/layout.json`, fetched
 * and validated as untrusted JSON like every other layout.
 */

/** Every stage this project ships. Six scenes, each a two-layer backdrop with depth. */
export const STAGE_IDS = [
  'stage-1',
  'stage-2',
  'stage-3',
  'stage-4',
  'stage-5',
  'stage-6',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

/**
 * The stage a `StageSelection` falls back to when no initial is supplied and no
 * seed is in hand -- a test, or a caller with nothing to derive from.
 *
 * The live page does not use it: `startup.ts` seeds the selection from
 * `stageForSeed(log.seed)`, and the hero from its own seed. It is the honest
 * "no information" answer, named here rather than spelled at a call site.
 */
export const DEFAULT_STAGE: StageId = STAGE_IDS[0];

/**
 * The stage a replay draws, derived from its own seed.
 *
 * This is what lets a direct replay link draw the same scenery every time with
 * no new Command Log field: the seed is already in the log, and a deterministic
 * default over it is the answer the frozen-contracts note calls for. A visitor
 * on the character-select screen overrides it for their own arcade Match; a
 * committed replay has no visitor, so it falls to the seed.
 */
export function stageForSeed(seed: number): StageId {
  const length = STAGE_IDS.length;
  const index = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % length : 0;
  return STAGE_IDS[index];
}

/**
 * Whether an arbitrary value names a stage.
 *
 * Used at the boundary where an id arrives from outside -- a select-screen
 * attribute, a query parameter -- and admitting one this project did not ship
 * would fetch a layout that 404s and drop the arena back to flat.
 */
export function isStageId(value: unknown): value is StageId {
  return typeof value === 'string' && (STAGE_IDS as readonly string[]).includes(value);
}

/**
 * Where this stage's backdrop is described.
 *
 * `/stages/<id>/layout.json`, one directory per stage, so this convention is
 * made explicit rather than spelled at the call site -- and it is what stops the
 * stage list and the asset URLs drifting apart.
 */
export function stageLayoutUrlFor(id: StageId): string {
  return `/stages/${id}/layout.json`;
}

/**
 * The stage a live Match is drawn on, and the ability to change it.
 *
 * Read through `stage()` at every draw rather than captured once, for the reason
 * `RosterSelection` is: the visitor can choose again between Matches, and a
 * surface holding a stale snapshot would draw the previous stage for the rest of
 * the session.
 */
export interface StageSelection {
  /** Which stage is drawn right now. The initial stage until something is chosen. */
  readonly stage: () => StageId;
  /** Picks `id`. A no-op when that stage is already showing. */
  readonly select: (id: StageId) => void;
}

export interface StageSelectionDeps {
  /** The stage before anything is chosen. `DEFAULT_STAGE` unless a caller says otherwise. */
  readonly initial?: StageId;
  /**
   * Called with the new stage after every change that is a change.
   *
   * This is how a pick reaches the scenery: `startup.ts` fetches the chosen
   * stage's layout and dresses every live surface with it. Not called on a
   * no-op re-selection, so picking the stage you already have does not re-fetch
   * a megabyte of scenery.
   */
  readonly onChange?: (id: StageId) => void;
}

export function createStageSelection(deps: StageSelectionDeps = {}): StageSelection {
  // Closure state in a factory, never a module-level binding.
  const state: { id: StageId } = { id: deps.initial ?? DEFAULT_STAGE };
  return Object.freeze({
    stage: (): StageId => state.id,
    select: (id: StageId): void => {
      if (state.id === id) {
        return;
      }
      state.id = id;
      deps.onChange?.(id);
    },
  });
}
