import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from '../../../../packages/env-fighter/src/config';
import {
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  phaseOf,
} from '../../../../packages/env-fighter/src/frames';
import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import { liveWindow, ticksIntoDecision } from './renderer';

/**
 * Story 9.5: the juice layer, as an indexed table rather than as a simulation.
 *
 * A hit currently reads as a state change and not as a hit: health drops, a
 * bar shortens, and nothing else happens. FR-39 asks for the four things a
 * fighting game does at that instant -- freeze, shake, spark, number -- and
 * every one of them is a *duration*, which is exactly where a presentation
 * layer normally reaches for a clock.
 *
 * This module never does. Three properties, and each one is a rule the rest of
 * the repo already lives by:
 *
 * 1. **Every duration is an integer count of film frames.** Nothing here reads
 *    `Date.now`, subtracts two timestamps, or schedules anything. The player's
 *    `PlaybackClock` advances exactly one frame per animation-frame callback
 *    (`player/clock.ts`), so "four frames of hitstop" means four callbacks and
 *    means the same thing on a 60Hz laptop, a 144Hz monitor and a backgrounded
 *    tab (INV-1, INV-3).
 *
 * 2. **The track is precomputed, not stepped.** The obvious way to write juice
 *    is a mutable effect list that ages by one on each frame. That is correct
 *    while playing forward and silently wrong the moment Story 4.5's scrub
 *    drags backwards, because the effect list has no memory of what it looked
 *    like at frame 90. So the whole track is built once, up front, and `at(i)`
 *    is an array read. Seeking to a frame and playing to it are then *the same
 *    operation*, which is a property a test can state and a stepped
 *    implementation cannot have.
 *
 * 3. **It is derived from the film, one way.** `deriveJuiceEvents` diffs
 *    `frame.from` against `frame.to`. It writes to no `FighterState`, imports
 *    nothing that hashes, and is read by nothing that computes a hash. The
 *    intent is that retuning any value in `DEFAULT_JUICE_TUNING` leaves
 *    `film.finalStateHash` untouched; `juice-neutrality.test.ts` exercises
 *    that on the demo Match by re-deriving the hash after a full juiced paint
 *    (AD-15, INV-2). Type-level one-wayness is not enforced by the compiler,
 *    so the test is the check, not a proof.
 *
 * ## On "the Command Log's event stream"
 *
 * The story asks for juice driven by the Command Log's event stream. There is
 * no such stream in the schema -- a Command Log stores *decisions*, not frames
 * and not events (see `replay/film.ts`'s docblock). The stream is therefore
 * derived here, from the re-simulated film, and it is derived purely: same
 * film in, same events out, every time. That purity is what makes point 2
 * possible at all.
 *
 * ## Where the numbers came from
 *
 * The frame counts and the shape of the shake decay are behavioural facts read
 * off the Extraction reference project (a hitstop of four frames on a light
 * hit; shake that decays linearly rather than exponentially). Facts, not
 * expression: none of its code is reproduced here, and every value below is a
 * field in a frozen table rather than a literal at a call site, which is what
 * AC2 asks for and what makes a retune a one-line data edit.
 *
 * ## Story 10.4: the Ultimate cinematic, hung on the same three properties
 *
 * The reference stops **both fighters for 90 ticks inside its simulation**
 * (`CINEMATIC_FREEZE = 90`). Porting that literally would change Tick counts,
 * Match length, the Decision Point budget and every Final-State Hash in this
 * repository -- a presentation flourish rewritten as a balance change, and
 * every committed Command Log invalidated with it.
 *
 * So the freeze is held **here**, over playback frames, and the simulation is
 * untouched. It is not a second mechanism either: hitstop above already
 * re-presents a film frame for N extra clock frames, and the cinematic is that
 * same hold, longer, keyed on a different trigger. The three properties carry
 * over unchanged -- the freeze is an integer frame count, the whole cinematic
 * is precomputed into the same table, and it is derived one way from the film.
 * `filmIndexAt` still visits every film frame exactly once as a live frame,
 * so the fight plays in full; only the number of callbacks it takes changes.
 *
 * The duration is the reference's own 90, re-homed: its loop and this player's
 * clock both advance one frame per animation-frame callback, so 90 there and
 * 90 here are the same length of held picture. What differs is *who owns it*.
 *
 * The look is translated rather than transliterated, per the story's standing
 * rule. The reference's VFX run on a real-time loop with a particle pool and
 * its own RNG; neither survives INV-1 or AD-15. The flash, the streaks and the
 * impact mark below are all indexed integer arithmetic over
 * `(filmIndex, agentIndex, ordinal)` through the same `scramble`/`jitter` the
 * sparks already use, so the cinematic drawn at clock frame 400 is the same
 * picture whether playback arrived there or a scrub jumped there.
 */

/**
 * What happened, coarsely. Three kinds because three is what the presentation
 * can actually distinguish at five Decision Points a second -- a scale with
 * more steps than a viewer can tell apart is a tuning surface with no readers.
 */
export type JuiceKind = 'hit' | 'heavy' | 'ko';

export interface JuiceEvent {
  /** The film frame this fires on. Always the first frame of a Decision Point. */
  readonly filmIndex: number;
  readonly kind: JuiceKind;
  /** The *struck* fighter, not the striker: the effect is drawn where it landed. */
  readonly agentIndex: 0 | 1;
  /** Health lost across this Decision Point. Always positive; a whiff produces no event. */
  readonly damage: number;
  /**
   * Where the struck fighter stood, as basis points across the arena.
   *
   * Basis points rather than pixels because this module has no viewport --
   * `juice-draw.ts` owns the one multiplication that turns this into a screen
   * coordinate, in the same spirit as `renderer.ts`'s `interpolatedX`: the
   * float appears at the canvas boundary and nowhere earlier.
   */
  readonly positionBasisPoints: number;
}

/** One tier of the damage-keyed shake curve. */
export interface ShakeTier {
  /**
   * The lowest damage this tier covers.
   *
   * The shipped table is written ascending because that is how it reads, but
   * nothing depends on the order: `shakeTierFor` selects the highest
   * `minDamage` at or below the damage, and a KO takes the largest-magnitude
   * tier. A hand-editable table that silently mis-graded every hit when a
   * later story appended a row in the wrong place would be a trap.
   */
  readonly minDamage: number;
  /** Peak offset in pixels, at the frame the hit lands. */
  readonly magnitude: number;
  /** How many frames the shake takes to decay to nothing. */
  readonly frames: number;
}

/** One kind's spark burst: how many squares, and how long they live. */
export interface SparkBurst {
  /** Squares in one burst. */
  readonly count: number;
  /** Frames a burst is on screen. It vanishes on the frame after the last. */
  readonly lifeFrames: number;
}

/**
 * Story 10.4. The Ultimate cinematic, entirely in frames and pixels.
 *
 * Every field is a count of **clock** frames or a pixel extent. Nothing here
 * is a millisecond, a ratio of a second, or an easing curve with a duration
 * baked into it (INV-1, INV-3). Setting `freezeFrames` to `0` removes the
 * cinematic completely -- no hold, no record on any frame, no drawn call --
 * which is the configuration `cinematic-neutrality.test.ts` compares the
 * shipped one against.
 */
export interface CinematicTuning {
  /**
   * Extra clock frames the Ultimate's active film frame is held for.
   *
   * The reference's `CINEMATIC_FREEZE`, moved from its simulation to this
   * renderer. `0` disables the cinematic outright.
   */
  readonly freezeFrames: number;
  /**
   * Opening frames that paint a full-stage plate.
   *
   * One solid plate, deliberately **not** a strobe. An alternating flash is
   * the obvious arcade idiom and it is also a photosensitivity trigger at the
   * frequency it would run at here (a plate every other frame is 30Hz); a
   * single 3-frame plate reads as the same impact and repeats nothing.
   */
  readonly flashFrames: number;
  /** First frame the title banner appears on, and how long it stays. */
  readonly titleFromFrame: number;
  readonly titleFrames: number;
  /** Frames the impact mark takes to reach its full extent. It then holds. */
  readonly impactFrames: number;
  /**
   * How far past the fighter it landed on the mark reaches, in basis points.
   *
   * Basis points across the arena, and derived from the *separation* rather
   * than being a fixed length, because a fixed one cannot be right at both
   * ends of the range. The first draft reached a flat 300px and the visual
   * gate caught it immediately: these two fighters were `minSeparation` apart,
   * so the mark drove straight through the opponent and ended in empty stage
   * -- a laser that missed, drawn on the frame the Ultimate connected.
   */
  readonly impactOvershootBasisPoints: number;
  /**
   * The shortest the mark may ever be, in basis points.
   *
   * A point-blank Ultimate has almost no separation to derive a length from,
   * and a two-pixel mark on the biggest Action in the game reads as nothing
   * having happened.
   */
  readonly impactMinBasisPoints: number;
  /** The impact mark's thickness, in pixels. */
  readonly impactBandPx: number;
  /** Height above the arena floor the impact mark is struck at, in pixels. */
  readonly impactHeightPx: number;
  /** Peak stage offset at the instant the Ultimate lands, in pixels. */
  readonly shakeMagnitude: number;
  /** Frames that shake decays to nothing over. */
  readonly shakeFrames: number;
  /** Squares thrown off the caster, and how far they may travel. */
  readonly streakCount: number;
  readonly streakReachPx: number;
  /** How high above the floor the streak field spans, in pixels. */
  readonly streakHeightPx: number;
  readonly streakSizePx: number;
}

export interface JuiceTuning {
  /**
   * Frames the film index is held on a hit, by kind.
   *
   * A KO holds longest deliberately. Extraction's own table reserves its
   * longest freeze (12) for a special rather than for a KO, but Tokenbrawl has
   * no special-vs-KO distinction to draw here and the I/O matrix is explicit
   * that a KO takes the longest hitstop and the largest shake tier -- so the
   * longest count in that table is spent on the one moment in a Match that is
   * worth stopping for.
   */
  readonly hitstopFrames: Readonly<Record<JuiceKind, number>>;
  /**
   * Damage at or above which a non-KO hit counts as `heavy`.
   *
   * A field rather than a comparison written at the point of use: AC2's "not a
   * hardcoded multiplier" is about the whole tuning surface, and a threshold
   * buried in an `if` is exactly as unretunable as a magnitude buried in one.
   */
  readonly heavyDamage: number;
  /**
   * Shake magnitude and duration by damage, ascending by `minDamage`.
   *
   * A table rather than `magnitude = damage * k`. A linear multiplier makes the
   * two ends of the range unusable at once -- either a chip hit rattles the
   * stage or a KO barely moves it -- and it offers nowhere to say "these two
   * damage values should feel the same". Tiers are also what makes the
   * clamping behaviour statable: below the first tier is the first tier, above
   * the last is the last, and nothing is ever negative or unbounded.
   */
  readonly shakeCurve: readonly ShakeTier[];
  /**
   * Burst size and lifetime *per kind*.
   *
   * Per kind rather than global because a single `sparkCount` makes a KO and a
   * chip hit emit an identical burst, which throws away the one cue that reads
   * at a glance while the health bars are still moving. The shipped counts
   * follow the Extraction reference: ~6 squares over 10 frames for a light
   * hit, ~10 over 14 for a heavy one, and more again for a KO.
   */
  readonly sparks: Readonly<Record<JuiceKind, SparkBurst>>;
  /** Frames the floating damage number is on screen. */
  readonly damageNumberFrames: number;
  /** How far the number drifts upward across its whole life, in pixels. */
  readonly damageNumberRisePx: number;
  /** Story 10.4. The Ultimate's cinematic. */
  readonly cinematic: CinematicTuning;
}

/**
 * The shipped tuning. Frozen, and frozen all the way down, in the same shape
 * as `animation.ts`'s `CLIP_FRAME_COUNTS`: a table a later story retunes by
 * editing a number, with no call site to go hunting for.
 */
export const DEFAULT_JUICE_TUNING: JuiceTuning = Object.freeze({
  hitstopFrames: Object.freeze({ hit: 4, heavy: 8, ko: 12 }),
  heavyDamage: 12,
  shakeCurve: Object.freeze([
    Object.freeze({ minDamage: 0, magnitude: 6, frames: 4 }),
    Object.freeze({ minDamage: 12, magnitude: 10, frames: 16 }),
    Object.freeze({ minDamage: 24, magnitude: 14, frames: 24 }),
  ]),
  sparks: Object.freeze({
    hit: Object.freeze({ count: 6, lifeFrames: 10 }),
    heavy: Object.freeze({ count: 10, lifeFrames: 14 }),
    ko: Object.freeze({ count: 14, lifeFrames: 18 }),
  }),
  damageNumberFrames: 24,
  damageNumberRisePx: 28,
  // 90 is the reference's own `CINEMATIC_FREEZE`, held by the renderer instead
  // of by the simulation. The segments inside it are laid out so the hold is
  // never a still picture: plate, then banner and expanding mark, then a
  // streak field that outlives both and carries the stage to the resume.
  cinematic: Object.freeze({
    freezeFrames: 90,
    flashFrames: 3,
    titleFromFrame: 3,
    titleFrames: 78,
    impactFrames: 22,
    impactOvershootBasisPoints: 1_000,
    impactMinBasisPoints: 1_200,
    impactBandPx: 16,
    impactHeightPx: 108,
    shakeMagnitude: 16,
    shakeFrames: 26,
    streakCount: 14,
    streakReachPx: 320,
    streakHeightPx: 210,
    streakSizePx: 7,
  }),
});

/** The arena bounds a position is scaled against. */
export interface ArenaBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * The arena a `FighterConfig` describes.
 *
 * Callers pass this rather than letting the module assume the shipped config:
 * a Match run under a retuned `arenaMin`/`arenaMax` would otherwise place
 * every spark and every number at the wrong x, silently, because the scale
 * factor was snapshotted at module load.
 */
export function arenaFor(config: Pick<FighterConfig, 'arenaMin' | 'arenaMax'>): ArenaBounds {
  return Object.freeze({ min: config.arenaMin, max: config.arenaMax });
}

/**
 * The shipped arena. A default argument rather than a required parameter so
 * `deriveJuiceEvents(frames)` reads as the spec names it, while a test can
 * still hand in a degenerate arena and check it does not divide by zero.
 * Every non-test caller passes `arenaFor(config)` explicitly.
 */
export const DEFAULT_ARENA: ArenaBounds = arenaFor(DEFAULT_FIGHTER_CONFIG);

/** One spark: an axis-aligned square, because the `Canvas2D` port has no paths. */
export interface JuiceSpark {
  /** The impact point, in basis points across the arena. Scatter is separate. */
  readonly positionBasisPoints: number;
  /**
   * Horizontal scatter from the impact point, in pixels, signed.
   *
   * A pixel offset rather than a basis-point one because this module has no
   * viewport and a px→basis-point conversion needs one: the earlier constant
   * that did the conversion here was both a viewport coupling in the wrong
   * file and numerically wrong for the shipped 960-wide stage.
   * `juice-draw.ts` owns the viewport and adds this after the scale.
   */
  readonly offsetPx: number;
  /**
   * Height above the arena floor, in pixels. Never negative -- a spark below
   * the floor line reads as a rendering fault, not as debris.
   */
  readonly heightPx: number;
  /**
   * Shrinks as the burst ages, which is how it dies.
   *
   * A square that shrank is the flat-block way to say "fading". Actually
   * fading it is not available: `docs/DESIGN.md` bans translucency and
   * `style-discipline.test.ts` enforces that by banning any `globalAlpha`
   * assignment other than `1` outside `backdrop.ts`. Shrinking reads the same
   * at five Decision Points a second and stays inside the house style.
   */
  readonly sizePx: number;
}

export interface JuiceNumber {
  readonly damage: number;
  readonly positionBasisPoints: number;
  readonly heightPx: number;
}

/**
 * Story 10.4. One Ultimate, at the film frame its active phase opens on.
 *
 * `filmIndex` is the *first* frame of the active run rather than every frame
 * in it. Under the shipped frame data the run is exactly one film frame wide
 * -- `specialWindow` is `10/5/45` ticks and the film samples 12 frames across
 * a 30-tick Decision Point, so ticks 10..14 are visible on one frame and one
 * only -- but a retuned window would widen it, and a cinematic that re-fired
 * on each frame of the run would freeze the stage several times over.
 */
export interface CinematicEvent {
  /** The film frame the Ultimate's active phase opens on. */
  readonly filmIndex: number;
  /** The *caster*, unlike `JuiceEvent.agentIndex`, which names the struck fighter. */
  readonly agentIndex: 0 | 1;
  readonly casterBasisPoints: number;
  readonly targetBasisPoints: number;
  /**
   * Whether the Ultimate took health off the opponent across this Decision
   * Point.
   *
   * The freeze happens either way -- AC1 keys it on the active phase, and an
   * Ultimate that is *about to whiff* is exactly as worth stopping for -- but
   * the impact mark and the extra shake are the connecting case's, per AC5.
   * A whiffed full-bar Action that still drew a hit mark would be the juice
   * layer telling the viewer something the simulation did not do.
   */
  readonly connected: boolean;
}

/** One square in the cinematic's streak field. */
export interface JuiceStreak {
  /** Signed pixel offset from the caster. */
  readonly offsetPx: number;
  /** Height above the arena floor, in pixels. Never negative. */
  readonly heightPx: number;
  readonly sizePx: number;
}

/** Everything the cinematic needs on one clock frame, or `null` on every other frame. */
export interface JuiceCinematic {
  readonly agentIndex: 0 | 1;
  readonly casterBasisPoints: number;
  readonly targetBasisPoints: number;
  readonly connected: boolean;
  /** Clock frames since the freeze opened. `0` on the one live frame. */
  readonly age: number;
  /** Total clock frames this cinematic occupies: the live frame plus every hold. */
  readonly frames: number;
  /** This frame paints the full-stage plate. */
  readonly flash: boolean;
  /** This frame carries the title banner. */
  readonly title: boolean;
  /**
   * How far the impact mark reaches from the caster, in basis points across
   * the arena. `0` draws nothing.
   *
   * Basis points rather than pixels, for the reason the whole module gives:
   * `juice-draw.ts` owns the one multiplication that turns this into a screen
   * coordinate, because it is the only file that has a viewport.
   */
  readonly reachBasisPoints: number;
  /** The impact mark's thickness in pixels, and the height it is struck at. */
  readonly bandPx: number;
  readonly heightPx: number;
  readonly streaks: readonly JuiceStreak[];
}

/**
 * Everything the overlay needs for one *clock* frame.
 *
 * Note "clock", not "film": with hitstop the two indexes diverge, and keeping
 * `filmIndex` on the record is what lets the player draw the held frame
 * without needing to know how the hold was produced.
 */
export interface JuiceFrame {
  readonly filmIndex: number;
  /** Whether this clock frame is a hitstop hold -- a re-present of the previous film index. */
  readonly frozen: boolean;
  /** Whole-pixel stage offsets. Integers: a sub-pixel shake is a blur, not a shake. */
  readonly shakeX: number;
  readonly shakeY: number;
  readonly sparks: readonly JuiceSpark[];
  readonly damageNumbers: readonly JuiceNumber[];
  /** Story 10.4. The Ultimate cinematic on this clock frame, or `null`. */
  readonly cinematic: JuiceCinematic | null;
}

export interface JuiceTrack {
  /** Clock frames, which is the film's length plus every hitstop hold. */
  readonly frameCount: number;
  /** The film frame a clock frame presents. Clamped at both ends. */
  readonly filmIndexAt: (clockIndex: number) => number;
  /** The juice at a clock frame. Clamped at both ends; never throws. */
  readonly at: (clockIndex: number) => JuiceFrame;
  /** The derived stream this track was built from. Exposed for tests and diagnostics. */
  readonly events: readonly JuiceEvent[];
  /** Story 10.4. The Ultimates this film contains, in film order. Same standing as `events`. */
  readonly cinematics: readonly CinematicEvent[];
}

/** The frame a film with no hits, or no frames at all, resolves to. */
const NEUTRAL_FRAME: JuiceFrame = Object.freeze({
  filmIndex: 0,
  frozen: false,
  shakeX: 0,
  shakeY: 0,
  sparks: Object.freeze([]),
  damageNumbers: Object.freeze([]),
  cinematic: null,
});

/**
 * Where a fighter stood, in basis points across the arena.
 *
 * Positions are read from `frame.to` rather than interpolated: damage is
 * applied *at* a Decision Point, not spread across it, so the place the hit
 * landed is the place the struck fighter ends up. That is the same choice
 * `renderer.ts` makes when it steps health and interpolates only position.
 *
 * A degenerate arena centres the effect instead of producing `NaN`. The same
 * belt-and-braces `interpolatedX` carries, and for the same reason: a `NaN`
 * coordinate paints nothing and reads as a blank-canvas bug.
 */
function positionBasisPoints(units: number, arena: ArenaBounds): number {
  const span = arena.max - arena.min;
  if (span <= 0) {
    return BASIS_POINTS_FULL / 2;
  }
  const scaled = Math.floor(((units - arena.min) * BASIS_POINTS_FULL) / span);
  return Math.max(0, Math.min(BASIS_POINTS_FULL, scaled));
}

/**
 * Diffs the film into the event stream the rest of this module consumes.
 *
 * Only the *first* frame of each Decision Point is inspected. Every frame
 * inside one carries the same `from`/`to` pair, so diffing all twelve would
 * fire the same hit twelve times -- which is the one bug in this file that
 * would look like a rendering choice ("the shake is very long") rather than a
 * defect.
 *
 * `windowHitLanded` is deliberately *not* the trigger. It says a Commitment
 * Window has connected, which is true of a blocked hit as well as a damaging
 * one, and it stays set for the rest of the window. Health falling is the
 * narrower and more honest signal: a hit the viewer should feel is one that
 * took something away.
 */
export function deriveJuiceEvents(
  frames: readonly RenderFrame[],
  tuning: JuiceTuning = DEFAULT_JUICE_TUNING,
  arena: ArenaBounds = DEFAULT_ARENA,
): readonly JuiceEvent[] {
  const events: JuiceEvent[] = [];

  for (const frame of frames) {
    if (frame.progressBasisPoints !== 0) {
      continue;
    }
    for (const agentIndex of [0, 1] as const) {
      const before = frame.from.health[agentIndex];
      const after = frame.to.health[agentIndex];
      const damage = before - after;
      if (damage <= 0) {
        continue;
      }
      // Damage dealt to a fighter that was already at or below zero is not a
      // hit the viewer should feel: the Match is over at that point and the
      // struck fighter is a corpse. Grading it by damage would fire a fresh
      // `hit`/`heavy` -- shake, sparks, a floating number -- on top of the KO
      // that already played, which reads as the KO not having landed.
      if (before <= 0) {
        continue;
      }

      const knockedOut = after <= 0;
      events.push(
        Object.freeze({
          filmIndex: frame.index,
          kind: knockedOut ? 'ko' : damage >= tuning.heavyDamage ? 'heavy' : 'hit',
          agentIndex,
          damage,
          positionBasisPoints: positionBasisPoints(frame.to.position[agentIndex], arena),
        }),
      );
    }
  }

  return Object.freeze(events);
}

/**
 * Diffs the film into the Ultimates it contains (Story 10.4).
 *
 * Every frame is inspected, not only the first of each Decision Point, because
 * that is the whole point: `specialWindow` is `10/5/45` ticks and a Decision
 * Point is 30, so the Ultimate's active phase opens and closes *strictly
 * between two samples* of the simulation. The same problem `liveWindow` was
 * written for in `renderer.ts` -- and the reason this asks that function
 * rather than reproducing it. A census over the demo Match found
 * `attack-active` played on zero of 360 frames before that reconstruction
 * existed; keying a 90-frame freeze off `frame.from` would have the cinematic
 * fire on a fighter already deep in recovery, or never.
 *
 * Only the *first* frame of each active run is emitted. Under the shipped
 * frame data a run is one frame wide, but a retuned window would widen it and
 * a freeze per frame of the run would stop the stage several times over.
 *
 * `connected` is read from the opponent's health across the Decision Point,
 * which is the same signal `deriveJuiceEvents` grades a hit on and the same
 * one for the same reason: `windowHitLanded` stays set for the rest of the
 * window and is true of a blocked hit as well as a damaging one.
 */
export function deriveCinematicEvents(
  frames: readonly RenderFrame[],
  config: FighterConfig = DEFAULT_FIGHTER_CONFIG,
  arena: ArenaBounds = DEFAULT_ARENA,
): readonly CinematicEvent[] {
  const events: CinematicEvent[] = [];
  // Whether each fighter's previous frame was already inside an active run, so
  // a run that spans several frames fires once. A local array in a pure
  // function, not a module binding -- `source-discipline.test.ts` bans the
  // latter and this is per-call state besides.
  const inRun = [false, false];

  for (const frame of frames) {
    const ticksElapsed = ticksIntoDecision(frame, config);
    for (const agentIndex of [0, 1] as const) {
      const open = liveWindow(frame, agentIndex, config, ticksElapsed);
      const active =
        open.committedAction === COMMITTED_SPECIAL &&
        phaseOf(config, open.committedAction, open.remaining) === PHASE_ACTIVE;

      if (!active) {
        inRun[agentIndex] = false;
        continue;
      }
      if (inRun[agentIndex]) {
        continue;
      }
      inRun[agentIndex] = true;

      const targetIndex = agentIndex === 0 ? 1 : 0;
      const before = frame.from.health[targetIndex];
      const after = frame.to.health[targetIndex];
      events.push(
        Object.freeze({
          filmIndex: frame.index,
          agentIndex,
          casterBasisPoints: positionBasisPoints(frame.to.position[agentIndex], arena),
          targetBasisPoints: positionBasisPoints(frame.to.position[targetIndex], arena),
          connected: before > 0 && after < before,
        }),
      );
    }
  }

  return Object.freeze(events);
}

/**
 * The curve tier a damage value falls in, clamped at both ends.
 *
 * Clamped rather than rejected: a config whose damage numbers move past the
 * last tier is an ordinary consequence of retuning `packages/env-fighter`, and
 * a juice layer that threw on it would turn a balance change into a blank
 * canvas. Below the lowest tier is the lowest tier; above the highest is the
 * highest.
 *
 * Order-independent on purpose. The table is advertised as hand-editable, so
 * "the last row is the biggest" is an assumption a future edit can quietly
 * break: selection is by highest `minDamage` at or below the damage, and ties
 * go to the first such row.
 */
export function shakeTierFor(tuning: JuiceTuning, damage: number): ShakeTier {
  const curve = tuning.shakeCurve;
  if (curve.length === 0) {
    return EMPTY_TIER;
  }

  const lowest = curve.reduce((low, tier) => (tier.minDamage < low.minDamage ? tier : low), curve[0]);
  const covering = curve.reduce<ShakeTier | null>(
    (chosen, tier) =>
      tier.minDamage <= damage && (chosen === null || tier.minDamage > chosen.minDamage)
        ? tier
        : chosen,
    null,
  );
  return covering ?? lowest;
}

/** The tier with nothing in it, for a tuning whose curve is empty. */
const EMPTY_TIER: ShakeTier = Object.freeze({ minDamage: 0, magnitude: 0, frames: 0 });

/**
 * The tier a KO uses: the largest, whatever the killing blow's damage was.
 *
 * "Largest" is the largest *magnitude*, not the last row -- same reason
 * `shakeTierFor` does not trust the ordering.
 */
function koTier(tuning: JuiceTuning): ShakeTier {
  const curve = tuning.shakeCurve;
  if (curve.length === 0) {
    return EMPTY_TIER;
  }
  return curve.reduce((best, tier) => (tier.magnitude > best.magnitude ? tier : best), curve[0]);
}

function tierFor(tuning: JuiceTuning, event: JuiceEvent): ShakeTier {
  return event.kind === 'ko' ? koTier(tuning) : shakeTierFor(tuning, event.damage);
}

/**
 * An integer scramble of two integers.
 *
 * `Math.random` is banned on this path and it is not a style preference: a
 * replay is a claim that a Match can be reproduced, and a stage that rattled
 * differently every time it was watched would quietly contradict that claim in
 * the one place a visitor is actually looking. Both `Math.imul` calls keep the
 * arithmetic in 32-bit integer space, so this produces the same offsets in
 * every engine, on every run.
 */
function scramble(a: number, b: number): number {
  const mixed = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  const folded = mixed ^ (mixed >>> 13);
  return Math.imul(folded, 0x27d4eb2d) >>> 0;
}

/** A deterministic integer in `[-range, range]`. */
function jitter(seed: number, salt: number, range: number): number {
  if (range <= 0) {
    return 0;
  }
  return (scramble(seed, salt) % (range * 2 + 1)) - range;
}

/** Linear decay, per Extraction's behaviour: full at the hit, nothing at the end. */
function decayed(magnitude: number, age: number, frames: number): number {
  if (frames <= 0 || age >= frames) {
    return 0;
  }
  return Math.round((magnitude * (frames - age)) / frames);
}

/** How far above the floor a burst sits: roughly chest height on the fighter. */
const SPARK_RISE_PX = 96;
/** How far a burst scatters from the impact point, in pixels either way. */
const SPARK_SCATTER_PX = 22;
const SPARK_SIZE_MIN_PX = 5;
const SPARK_SIZE_RANGE_PX = 5;
/** The size a spark has shrunk to on its last frame. Never zero -- it vanishes by lifetime, not by size. */
const SPARK_SIZE_FLOOR_PX = 1;
/** Where the damage number starts, before it drifts up by `damageNumberRisePx`. */
const NUMBER_RISE_PX = 120;
/**
 * The highest a spark may sit above the floor.
 *
 * A ceiling and a floor rather than an unbounded rise, because scatter is
 * multiplied by age: without a bound the tail of a long burst leaves the stage
 * entirely, drawing off-canvas at the top and *below the ground line* at the
 * bottom. `juice-draw.ts` clamps again against the real viewport; this bound
 * is the viewport-free half of the same rule.
 */
const SPARK_MAX_HEIGHT_PX = 240;
/**
 * The furthest a spark may scatter sideways from the impact point.
 *
 * The horizontal half of the same rule as `SPARK_MAX_HEIGHT_PX`: scatter is
 * multiplied by age, so a long burst's tail would otherwise reach ±396px on a
 * 960px stage, and `juice-draw.ts`'s viewport clamp does not discard those --
 * it *pins* them, turning the tail of a KO into a column of squares flat
 * against the canvas edge. Bounding here keeps the burst a burst.
 */
const SPARK_MAX_OFFSET_PX = 240;
/**
 * Seed strides, chosen so no two `(filmIndex, agentIndex, ordinal)` triples
 * collide. `agentIndex`'s stride must exceed the largest `sparks[*].count`
 * (14, for a KO) or half of one fighter's burst would be a pixel-identical
 * clone of the other's on a trade -- the very case `deriveJuiceEvents` emits
 * two events for, and the case the shake at `buildJuiceTrack` decorrelates.
 */
const SEED_AGENT_STRIDE = 97;
const SEED_FRAME_STRIDE = 1021;
/**
 * Offset that keeps a cinematic's streak seeds clear of the spark seeds drawn
 * from the same `(filmIndex, agentIndex)` pair. Larger than the largest
 * `sparks[*].count` and than `SEED_AGENT_STRIDE`, so no streak ordinal can
 * land on a spark ordinal's seed and produce a pixel-identical clone of it.
 */
const SEED_CINEMATIC_OFFSET = 524_287;

/** The burst tuning for a kind, falling back to the light one for an unknown kind. */
function sparkBurstFor(tuning: JuiceTuning, kind: JuiceKind): SparkBurst {
  return tuning.sparks[kind] ?? tuning.sparks.hit;
}

/**
 * The sparks for one event at one age, or an empty list once the burst is over.
 *
 * Scatter is derived from `(filmIndex, agentIndex, sparkOrdinal)`, so a burst
 * looks the same every time that film frame is presented -- including when it
 * is re-presented by a scrub, which is what makes seeking and playing agree.
 */
function sparksFor(
  event: JuiceEvent,
  age: number,
  tuning: JuiceTuning,
): readonly JuiceSpark[] {
  const burst = sparkBurstFor(tuning, event.kind);
  if (age < 0 || age >= burst.lifeFrames) {
    return [];
  }

  const sparks: JuiceSpark[] = [];
  for (let ordinal = 0; ordinal < burst.count; ordinal += 1) {
    const seed =
      event.filmIndex * SEED_FRAME_STRIDE + event.agentIndex * SEED_AGENT_STRIDE + ordinal;
    // Sparks fly outward as they age: the offset a spark was born with is
    // multiplied by how far through its life it is, so the burst opens rather
    // than merely blinking. Integer arithmetic throughout.
    const spread = age + 1;
    const scatteredPx = jitter(seed, 1, SPARK_SCATTER_PX) * spread;
    const offsetPx = Math.max(-SPARK_MAX_OFFSET_PX, Math.min(SPARK_MAX_OFFSET_PX, scatteredPx));
    const risePx = jitter(seed, 2, SPARK_SCATTER_PX) * spread;
    const bornSizePx = SPARK_SIZE_MIN_PX + (scramble(seed, 3) % SPARK_SIZE_RANGE_PX);
    sparks.push(
      Object.freeze({
        positionBasisPoints: event.positionBasisPoints,
        offsetPx,
        heightPx: Math.max(0, Math.min(SPARK_MAX_HEIGHT_PX, SPARK_RISE_PX + risePx)),
        sizePx: Math.max(
          SPARK_SIZE_FLOOR_PX,
          bornSizePx - Math.floor(((bornSizePx - SPARK_SIZE_FLOOR_PX) * age) / burst.lifeFrames),
        ),
      }),
    );
  }
  return Object.freeze(sparks);
}

/** The floating number for one event at one age, or `null` once it has expired. */
function numberFor(event: JuiceEvent, age: number, tuning: JuiceTuning): JuiceNumber | null {
  if (age < 0 || age >= tuning.damageNumberFrames) {
    return null;
  }
  return Object.freeze({
    damage: event.damage,
    positionBasisPoints: event.positionBasisPoints,
    heightPx:
      NUMBER_RISE_PX + Math.floor((tuning.damageNumberRisePx * age) / tuning.damageNumberFrames),
  });
}

/**
 * The streak field around the caster at one age (Story 10.4).
 *
 * The reference throws particles from a pool, each with its own lifetime and
 * its own draw from a shared RNG. Neither survives here: a pool is stepped
 * state, which a scrub cannot rewind, and an ungoverned RNG makes the same
 * frame draw differently on two viewings. So the field is *phase-offset*
 * instead -- every square owns a fixed slice of the cycle, derived from its
 * ordinal, and its position at any age is that slice plus the age, modulo the
 * cycle. The field therefore looks continuously alive while being a pure
 * function of `(filmIndex, agentIndex, ordinal, age)`, which is what makes
 * seeking into the middle of a freeze show the same picture playing into it
 * does.
 */
function streaksFor(
  event: CinematicEvent,
  age: number,
  tuning: JuiceTuning,
): readonly JuiceStreak[] {
  const shape = tuning.cinematic;
  const cycle = Math.max(1, shape.freezeFrames);
  const spanPx = Math.max(0, shape.streakHeightPx);
  const toward = event.targetBasisPoints >= event.casterBasisPoints ? 1 : -1;

  const streaks: JuiceStreak[] = [];
  for (let ordinal = 0; ordinal < Math.max(0, shape.streakCount); ordinal += 1) {
    const seed =
      event.filmIndex * SEED_FRAME_STRIDE +
      event.agentIndex * SEED_AGENT_STRIDE +
      SEED_CINEMATIC_OFFSET +
      ordinal;
    const phase = (age + (scramble(seed, 11) % cycle)) % cycle;
    const travelledPx = Math.floor((Math.max(0, shape.streakReachPx) * phase) / cycle);
    // Mostly outward toward the opponent, one square in five thrown back the
    // other way: a field that all travels one direction reads as a scrolling
    // background rather than as debris coming off a fighter.
    const direction = scramble(seed, 12) % 5 === 0 ? -toward : toward;
    streaks.push(
      Object.freeze({
        offsetPx: direction * travelledPx,
        heightPx: spanPx === 0 ? 0 : scramble(seed, 13) % (spanPx + 1),
        // Shrinks across its slice, the same way a spark dies: the flat-block
        // way to say "fading" when `docs/DESIGN.md` bans translucency outright.
        sizePx: Math.max(
          1,
          Math.max(1, shape.streakSizePx) -
            Math.floor((Math.max(1, shape.streakSizePx) * phase) / (cycle * 2)),
        ),
      }),
    );
  }
  return Object.freeze(streaks);
}

/**
 * How far the impact mark reaches at full extension, in basis points.
 *
 * The separation between the two fighters plus a fixed overshoot, floored so a
 * point-blank Ultimate still leaves a mark and capped at the arena so it can
 * never be drawn off-stage.
 */
function fullReachFor(event: CinematicEvent, tuning: JuiceTuning): number {
  const shape = tuning.cinematic;
  const separation = Math.abs(event.targetBasisPoints - event.casterBasisPoints);
  return Math.min(
    BASIS_POINTS_FULL,
    Math.max(
      Math.max(0, shape.impactMinBasisPoints),
      separation + Math.max(0, shape.impactOvershootBasisPoints),
    ),
  );
}

/** The whole cinematic record for one event at one age. */
function cinematicAt(event: CinematicEvent, age: number, tuning: JuiceTuning): JuiceCinematic {
  const shape = tuning.cinematic;
  // Expands to full reach and then *stays* there: AC5 asks for an impact
  // mark, and a mark that retracted would be a second flash.
  const reachBasisPoints = event.connected
    ? Math.floor(
        (fullReachFor(event, tuning) *
          Math.min(Math.max(0, age), Math.max(1, shape.impactFrames))) /
          Math.max(1, shape.impactFrames),
      )
    : 0;

  return Object.freeze({
    agentIndex: event.agentIndex,
    casterBasisPoints: event.casterBasisPoints,
    targetBasisPoints: event.targetBasisPoints,
    connected: event.connected,
    age,
    frames: Math.max(0, shape.freezeFrames) + 1,
    flash: age < shape.flashFrames,
    title: age >= shape.titleFromFrame && age < shape.titleFromFrame + shape.titleFrames,
    reachBasisPoints,
    bandPx: shape.impactBandPx,
    heightPx: shape.impactHeightPx,
    streaks: streaksFor(event, age, tuning),
  });
}

/**
 * The cinematic a reduced-motion viewer gets: the same beat, standing still.
 *
 * The freeze itself is kept -- the track's shape is never flattened, for the
 * reason `buildJuiceTrack`'s `reducedMotion` note gives -- but the plate, the
 * streak field and the mark's expansion all go. What is left is a still title
 * card with the mark already drawn at full reach, which says the same thing
 * without any of the three motions that made it worth switching off: a
 * full-stage luminance change, a moving particle field, and a camera shake.
 */
function stilled(
  cinematic: JuiceCinematic,
  event: CinematicEvent,
  tuning: JuiceTuning,
): JuiceCinematic {
  return Object.freeze({
    ...cinematic,
    flash: false,
    reachBasisPoints: cinematic.connected ? fullReachFor(event, tuning) : 0,
    streaks: Object.freeze([]),
  });
}

/**
 * Builds the whole track: one entry per clock frame, hitstop holds included.
 *
 * The mapping is the load-bearing idea. A hitstop does not *skip* film frames
 * and it does not slow the film down -- it re-presents the film frame the hit
 * landed on for `hitstopFrames` extra clock frames, and then the film resumes
 * on the very next frame it would have reached anyway. So the film is played
 * in full, in order, exactly once, whatever the tuning says; only the number
 * of callbacks it takes changes. That is what lets the hash-neutrality claim
 * be about drawing rather than about hoping.
 *
 * Effects age in *clock* frames, not film frames, so a shake that starts under
 * a freeze is visible during the freeze. A viewer should see the stage kick
 * while it is held, which is the whole reason the two are tuned together.
 */
export function buildJuiceTrack(
  frames: readonly RenderFrame[],
  tuning: JuiceTuning = DEFAULT_JUICE_TUNING,
  arena: ArenaBounds = DEFAULT_ARENA,
  /**
   * Story 9.5 accessibility. When the viewer asked for less motion, the track
   * keeps its shape -- same frame count, same clock→film mapping, so the
   * transport, the scrub and every index-based assertion behave identically --
   * and every frame reports zero shake and no particles.
   *
   * The mapping is deliberately *not* flattened. `player/clock.ts` already
   * declines to autoplay under the preference, but a reduced-motion visitor
   * who scrubs would otherwise get the full damage-scaled camera shake, which
   * is the canonical vestibular trigger and the single most important thing
   * this flag has to switch off.
   */
  reducedMotion = false,
  /**
   * Story 10.4. The frame data the Ultimate's active phase is located against.
   *
   * Passed rather than assumed for the same reason `arena` is: a Match run
   * under a retuned `specialWindow` would otherwise have its cinematic fire on
   * the wrong film frame -- or on none -- while the fighter itself drew the
   * correct phase, because `renderer.ts` reads the live config and this would
   * have snapshotted the shipped one at module load.
   */
  config: FighterConfig = DEFAULT_FIGHTER_CONFIG,
): JuiceTrack {
  const events = deriveJuiceEvents(frames, tuning, arena);
  const cinematics = deriveCinematicEvents(frames, config, arena);

  // Which events fire on which film frame, and the longest hold that film
  // frame owes. Two fighters can trade in one Decision Point; the stage cannot
  // freeze twice, so the longer freeze wins rather than the two summing into a
  // hold nobody tuned.
  const byFilmIndex = new Map<number, JuiceEvent[]>();
  for (const event of events) {
    const bucket = byFilmIndex.get(event.filmIndex);
    if (bucket === undefined) {
      byFilmIndex.set(event.filmIndex, [event]);
      continue;
    }
    bucket.push(event);
  }

  // Which film frame each Ultimate opens on. First event wins: two fighters
  // whose Ultimates go active on the same film frame is a double-KO-shaped
  // coincidence the stage cannot express twice, and one freeze carrying one
  // caster is a truthful picture where two overlaid cinematics would be a
  // smear. `freezeFrames <= 0` removes the cinematic outright -- no hold, no
  // record, and therefore a call sequence byte-identical to the one this
  // player drew before Story 10.4.
  const freezeFrames = Math.max(0, tuning.cinematic.freezeFrames);
  const cinematicByFilmIndex = new Map<number, CinematicEvent>();
  if (freezeFrames > 0) {
    for (const cinematic of cinematics) {
      if (!cinematicByFilmIndex.has(cinematic.filmIndex)) {
        cinematicByFilmIndex.set(cinematic.filmIndex, cinematic);
      }
    }
  }

  // Every event's first clock frame, so ages are a subtraction rather than a
  // search. Built in the same walk that builds the track.
  const startedAt = new Map<JuiceEvent, number>();
  const cinematicStartedAt = new Map<CinematicEvent, number>();
  const filmIndexes: number[] = [];
  const frozenFlags: boolean[] = [];

  for (const frame of frames) {
    const fired = byFilmIndex.get(frame.index) ?? [];
    for (const event of fired) {
      startedAt.set(event, filmIndexes.length);
    }
    const cinematic = cinematicByFilmIndex.get(frame.index);
    if (cinematic !== undefined) {
      cinematicStartedAt.set(cinematic, filmIndexes.length);
    }
    filmIndexes.push(frame.index);
    frozenFlags.push(false);

    // One hold, not two. A hit and an Ultimate can land on the same film frame
    // -- and the longer of the two wins, exactly as two simultaneous hits
    // already resolve to the longer hitstop. Summing them would produce a
    // freeze nobody tuned, and the cinematic's own count is the one the
    // reference chose.
    const hold = Math.max(
      fired.reduce((longest, event) => Math.max(longest, tuning.hitstopFrames[event.kind] ?? 0), 0),
      cinematic === undefined ? 0 : freezeFrames,
    );
    for (let held = 0; held < hold; held += 1) {
      filmIndexes.push(frame.index);
      frozenFlags.push(true);
    }
  }

  // The peak magnitude in the table, used to cap simultaneous shakes. Two hits
  // in one Decision Point add up, but never past what the largest single hit
  // is allowed to do -- an unbounded sum is how a stage ends up off-screen.
  const maxMagnitude = tuning.shakeCurve.reduce(
    (largest, tier) => Math.max(largest, tier.magnitude),
    0,
  );

  // Which events are still alive on which clock frame.
  //
  // The naive build scans every event on every clock frame, which is
  // `O(clockFrames x events)` of synchronous work at mount for a track whose
  // events are each alive for a few dozen frames. Bucketing by the window an
  // event is actually visible in makes the build proportional to the total
  // effect-frames instead, and changes nothing about what `at(n)` answers.
  const activeByClock: JuiceEvent[][] = filmIndexes.map(() => []);
  for (const event of events) {
    const start = startedAt.get(event) ?? 0;
    const tier = tierFor(tuning, event);
    const span = Math.max(
      tier.frames,
      sparkBurstFor(tuning, event.kind).lifeFrames,
      tuning.damageNumberFrames,
    );
    const end = Math.min(filmIndexes.length, start + Math.max(0, span));
    for (let clockIndex = Math.max(0, start); clockIndex < end; clockIndex += 1) {
      activeByClock[clockIndex].push(event);
    }
  }

  // Which cinematic, if any, owns each clock frame. Bucketed the same way the
  // hit events are, and for the same reason: `at(n)` must be an array read, so
  // that seeking to a frame and playing to it are the same operation.
  const cinematicByClock: (CinematicEvent | null)[] = filmIndexes.map(() => null);
  for (const cinematic of cinematicByFilmIndex.values()) {
    const start = cinematicStartedAt.get(cinematic);
    if (start === undefined) {
      continue;
    }
    const end = Math.min(filmIndexes.length, start + freezeFrames + 1);
    for (let clockIndex = Math.max(0, start); clockIndex < end; clockIndex += 1) {
      cinematicByClock[clockIndex] = cinematic;
    }
  }

  const lastClockIndex = filmIndexes.length - 1;

  const track: JuiceFrame[] = filmIndexes.map((filmIndex, clockIndex) => {
    const frozen = frozenFlags[clockIndex];

    const owner = cinematicByClock[clockIndex];
    const cinematic =
      owner === null
        ? null
        : cinematicAt(owner, clockIndex - (cinematicStartedAt.get(owner) ?? 0), tuning);
    // Two cases resolve to a still stage.
    //
    // Reduced motion: the viewer asked for it, and it must hold on a scrub as
    // well as on autoplay.
    //
    // The final clock frame: playback stops there and stays there. A hit or a
    // KO landing on the last film frame would otherwise leave the stage
    // permanently offset by its shake, with a damage number frozen mid-rise --
    // an end state that reads as a broken layout rather than as a finished
    // Match.
    if (reducedMotion || clockIndex === lastClockIndex) {
      return Object.freeze({
        filmIndex,
        frozen,
        shakeX: 0,
        shakeY: 0,
        sparks: Object.freeze([]),
        damageNumbers: Object.freeze([]),
        // The final clock frame drops the cinematic entirely, for the same
        // reason it drops the shake: playback rests there indefinitely, and a
        // title banner or a half-drawn impact mark left on screen forever
        // reads as a broken layout rather than as a finished Match.
        cinematic:
          clockIndex === lastClockIndex || cinematic === null || owner === null
            ? null
            : stilled(cinematic, owner, tuning),
      });
    }

    const sparks: JuiceSpark[] = [];
    // At most one number per struck fighter: the most recent.
    //
    // `damageNumberFrames` outlives a Decision Point, so consecutive hits on
    // one fighter would otherwise stack two opaque numbers a few pixels apart
    // and render both unreadable. The newer hit is the one the viewer is
    // looking for.
    const latestNumber = new Map<number, { readonly start: number; readonly number: JuiceNumber }>();
    const shake = { x: 0, y: 0 };

    for (const event of activeByClock[clockIndex]) {
      const start = startedAt.get(event) ?? 0;
      const age = clockIndex - start;
      if (age < 0) {
        continue;
      }

      const tier = tierFor(tuning, event);
      const magnitude = decayed(tier.magnitude, age, tier.frames);
      if (magnitude > 0) {
        // Seeded on the clock index so the offset changes every frame (a shake
        // that held still would read as a mis-centred stage), and on the
        // *event's identity* so two events at one instant decorrelate. Seeding
        // on the magnitude instead made two same-tier hits in one Decision
        // Point produce the identical offset, which then summed to exactly
        // double it -- a doubled, saturating kick that looked like one bug
        // shared between two fighters.
        const salt = event.filmIndex * 31 + event.agentIndex * 7 + 1;
        shake.x += jitter(clockIndex, salt, magnitude);
        shake.y += jitter(clockIndex, salt + 977, magnitude);
      }

      sparks.push(...sparksFor(event, age, tuning));
      const number = numberFor(event, age, tuning);
      if (number !== null) {
        const held = latestNumber.get(event.agentIndex);
        if (held === undefined || start >= held.start) {
          latestNumber.set(event.agentIndex, { start, number });
        }
      }
    }

    // Ordered by agent index rather than by map insertion, so the drawn output
    // is a function of the frame and not of the order events were bucketed in.
    const damageNumbers = [0, 1]
      .map((agentIndex) => latestNumber.get(agentIndex)?.number)
      .filter((number): number is JuiceNumber => number !== undefined);

    // The cinematic's shake is added *after* the hit shake is clamped, and
    // bounded by its own magnitude rather than folded into `maxMagnitude`.
    // Widening that cap instead would let two ordinary simultaneous hits sum
    // higher than they do today -- a silent retune of every Match that has
    // never seen an Ultimate, which is exactly what this story must not do.
    const cinematicMagnitude =
      cinematic === null
        ? 0
        : decayed(
            Math.max(0, tuning.cinematic.shakeMagnitude),
            cinematic.age,
            Math.max(0, tuning.cinematic.shakeFrames),
          );
    const cinematicSalt = cinematic === null ? 0 : cinematic.agentIndex * 13 + 2_003;

    return Object.freeze({
      filmIndex,
      frozen,
      shakeX:
        Math.max(-maxMagnitude, Math.min(maxMagnitude, shake.x)) +
        jitter(clockIndex, cinematicSalt, cinematicMagnitude),
      shakeY:
        Math.max(-maxMagnitude, Math.min(maxMagnitude, shake.y)) +
        jitter(clockIndex, cinematicSalt + 613, cinematicMagnitude),
      sparks: Object.freeze(sparks),
      damageNumbers: Object.freeze(damageNumbers),
      cinematic,
    });
  });

  const clamp = (clockIndex: number): number => {
    if (!Number.isFinite(clockIndex)) {
      return 0;
    }
    return Math.max(0, Math.min(track.length - 1, Math.floor(clockIndex)));
  };

  return Object.freeze({
    frameCount: track.length,
    events,
    cinematics,
    // A film with no frames has no juice and no film index to hold: both
    // accessors answer with the neutral value rather than throwing, so an
    // empty log renders a blank stage instead of killing the page.
    filmIndexAt: (clockIndex: number): number =>
      track.length === 0 ? 0 : track[clamp(clockIndex)].filmIndex,
    at: (clockIndex: number): JuiceFrame =>
      track.length === 0 ? NEUTRAL_FRAME : track[clamp(clockIndex)],
  });
}
