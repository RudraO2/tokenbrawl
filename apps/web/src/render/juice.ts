import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from '../../../../packages/env-fighter/src/config';
import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';

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
}

/** The frame a film with no hits, or no frames at all, resolves to. */
const NEUTRAL_FRAME: JuiceFrame = Object.freeze({
  filmIndex: 0,
  frozen: false,
  shakeX: 0,
  shakeY: 0,
  sparks: Object.freeze([]),
  damageNumbers: Object.freeze([]),
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
): JuiceTrack {
  const events = deriveJuiceEvents(frames, tuning, arena);

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

  // Every event's first clock frame, so ages are a subtraction rather than a
  // search. Built in the same walk that builds the track.
  const startedAt = new Map<JuiceEvent, number>();
  const filmIndexes: number[] = [];
  const frozenFlags: boolean[] = [];

  for (const frame of frames) {
    const fired = byFilmIndex.get(frame.index) ?? [];
    for (const event of fired) {
      startedAt.set(event, filmIndexes.length);
    }
    filmIndexes.push(frame.index);
    frozenFlags.push(false);

    const hold = fired.reduce(
      (longest, event) => Math.max(longest, tuning.hitstopFrames[event.kind] ?? 0),
      0,
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

  const lastClockIndex = filmIndexes.length - 1;

  const track: JuiceFrame[] = filmIndexes.map((filmIndex, clockIndex) => {
    const frozen = frozenFlags[clockIndex];
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

    return Object.freeze({
      filmIndex,
      frozen,
      shakeX: Math.max(-maxMagnitude, Math.min(maxMagnitude, shake.x)),
      shakeY: Math.max(-maxMagnitude, Math.min(maxMagnitude, shake.y)),
      sparks: Object.freeze(sparks),
      damageNumbers: Object.freeze(damageNumbers),
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
    // A film with no frames has no juice and no film index to hold: both
    // accessors answer with the neutral value rather than throwing, so an
    // empty log renders a blank stage instead of killing the page.
    filmIndexAt: (clockIndex: number): number =>
      track.length === 0 ? 0 : track[clamp(clockIndex)].filmIndex,
    at: (clockIndex: number): JuiceFrame =>
      track.length === 0 ? NEUTRAL_FRAME : track[clamp(clockIndex)],
  });
}
