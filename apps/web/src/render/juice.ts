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
  /**
   * Frames a burst is on screen. It vanishes on the frame after the last.
   *
   * Story 11.2 pins these to `impactFrames`, so a burst and the impact sprite
   * drawn at its contact point expire on the same clock frame. Debris that
   * outlived the flash that threw it read as two unrelated effects.
   */
  readonly lifeFrames: number;
}

/**
 * Story 10.4, re-timed into three acts by Story 11.4. The Ultimate cinematic,
 * entirely in frames and pixels.
 *
 * Every field is a count of **clock** frames, a pixel extent, or basis points.
 * Nothing here is a millisecond, a ratio of a second, or an easing curve with a
 * duration baked into it (INV-1, INV-3). Setting `freezeFrames` to `0` removes
 * the cinematic completely -- no hold, no record on any frame, no drawn call --
 * which is the configuration `cinematic-neutrality.test.ts` compares the
 * shipped one against.
 *
 * ## Why 11.4 re-timed rather than rewrote
 *
 * 10.4's cinematic was correct and **front-loaded**: the flash was the first
 * thing that happened. The reference is back-loaded, and that is the whole
 * reason its version reads as a payoff -- an orb builds at the caster's hand
 * across ~78 ticks, blooms into a muzzle flash, the screen slams white at tick
 * 80, and only *then* does a beam fire. So the freeze, the record, the streak
 * field and the shake are all kept exactly as they were, and the counts below
 * are re-laid-out into build / slam / release.
 *
 * ## Pixel extents are scaled, frame counts are not
 *
 * The reference's stage is 1920x1080 and this one is 960x400. Every pixel
 * extent below is therefore its reference value scaled **by height** -- 140
 * letterbox becomes 52, a 96px beam becomes 36, an 80px orb radius becomes 30 --
 * while every *frame* count is copied unchanged, because a tick there and a
 * clock frame here are both one animation frame and the feel of a curve is in
 * its duration.
 */
export interface CinematicTuning {
  /**
   * Extra clock frames the Ultimate's active film frame is held for.
   *
   * The reference's `CINEMATIC_FREEZE`, moved from its simulation to this
   * renderer. `0` disables the cinematic outright.
   *
   * Note what this is **not**: the cinematic's length. The release act runs on
   * past the freeze, over resumed playback, exactly as the reference nulls
   * `state.cinematic` at tick 80 and lets its 50-tick `beamWindow` play over
   * live gameplay. `JuiceCinematic.frames` is the total.
   */
  readonly freezeFrames: number;
  /**
   * Frames the letterbox bars take to slide in, on `easeOutBack`, and their
   * settled height in pixels.
   *
   * The overshoot is the reference's and it is worth keeping: bars that
   * overshoot and settle read as a camera framing a shot, where bars that ease
   * flatly read as a UI panel opening.
   */
  readonly letterboxFrames: number;
  readonly letterboxHeightPx: number;
  /**
   * How dark the vignette's outer edge gets, in basis points of full opacity.
   *
   * The reference builds this with `createRadialGradient`, which the `Canvas2D`
   * port does not have and which this story is not the one that widens it for.
   * `juice-draw.ts` draws the same darkening as a stack of edge bands, so this
   * is the strength of the outermost one.
   */
  readonly vignetteBasisPoints: number;
  /** When the caster's portrait starts sliding in, and how long it takes. */
  readonly portraitFromFrame: number;
  readonly portraitFrames: number;
  /** The portrait's drawn size in pixels, at the reference's aspect ratio. */
  readonly portraitWidthPx: number;
  readonly portraitHeightPx: number;
  /**
   * Frames the energy orb grows across, and the radii it grows between.
   *
   * The growth is `age²` rather than linear -- the reference's `growP * growP`
   * -- which is what makes the build *accelerate* into the bloom instead of
   * crawling toward it at a constant rate.
   */
  readonly orbFrames: number;
  readonly orbMinPx: number;
  readonly orbMaxPx: number;
  /**
   * When the orb blooms into a muzzle flash, over how many frames, and by how
   * much.
   *
   * `bloomBasisPoints` is the *extra* scale at full bloom, so the reference's
   * `finalR = orbR * (1 + boomP * 2.2)` is `22_000` here.
   */
  readonly bloomFromFrame: number;
  readonly bloomFrames: number;
  readonly bloomBasisPoints: number;
  /**
   * The slam: a full-viewport plate near the end of the freeze, tinted with the
   * caster's aura.
   *
   * Still deliberately **not** a strobe -- one rise and one fall, no repeat.
   * 10.4's docblock made that argument about a 3-frame plate at the *start*;
   * the argument is unchanged and the plate now ramps its alpha down across
   * `slamFrames` rather than sitting solid, which is a smaller luminance event
   * than the one it replaces.
   *
   * `slamTintBasisPoints` is how much of the caster's aura is mixed into white
   * (the reference's `mixHex(white, aura, 0.4)` at `screens.js:1500`).
   */
  readonly slamFromFrame: number;
  readonly slamFrames: number;
  readonly slamTintBasisPoints: number;
  /**
   * The release: when the beam fires, how long it is on screen, and how many
   * frames it takes to sweep out to full extent on `easeOutCubic`.
   *
   * `releaseFromFrame` is the reference's tick 80 -- the same frame the slam
   * lands on, because the flash is what covers the cut back to gameplay.
   */
  readonly releaseFromFrame: number;
  readonly releaseFrames: number;
  readonly beamSweepFrames: number;
  /** The beam's thickness in pixels. The reference's 96 on a 1080-tall stage. */
  readonly beamThicknessPx: number;
  /**
   * How much larger the impact art is drawn than the beam, in basis points.
   *
   * The reference draws it at 1.8x so an Ultimate's impact clearly out-scales
   * an ordinary blast's.
   */
  readonly impactScaleBasisPoints: number;
  /** First frame the title banner appears on, and how long it stays. */
  readonly titleFromFrame: number;
  readonly titleFrames: number;
  /** Frames the impact mark takes to reach its full extent. It then holds. */
  readonly impactFrames: number;
  /**
   * The shortest the beam may ever be, in basis points.
   *
   * The reference's `Math.max(420, edgeLen)`: a caster standing at the arena
   * edge they are facing has almost no distance to fire across, and a
   * two-pixel beam on the biggest Action in the game reads as nothing having
   * happened. `420/1920` of the stage is `2_187` basis points.
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
  /**
   * Story 11.2. Clock frames the impact sprite is on screen, per kind.
   *
   * Must equal the mapped pose's `frames * holdFrames` in
   * `public/fx/layout.json`, or the sprite either freezes on its last cell
   * (tuning too long) or is cut off mid-pose (too short). The layout describes
   * the *art*; this describes the *effect*; `juice.test.ts` reads the shipped
   * layout from disk and asserts the two agree, which is the cheapest possible
   * guard against a retune silently desynchronising from the sheet.
   */
  readonly impactFrames: Readonly<Record<JuiceKind, number>>;
  /** Height above the arena floor the impact sprite is centred at, in pixels. */
  readonly impactHeightPx: Readonly<Record<JuiceKind, number>>;
  /**
   * The drawn size of the impact sprite, in pixels, per kind.
   *
   * Graded for the same reason the burst counts are: a KO and a chip hit that
   * threw the same flash would throw away the one cue that reads at a glance
   * while the health bars are still moving.
   */
  readonly impactSizePx: Readonly<Record<JuiceKind, number>>;
  /**
   * Clock frames at the *end* of an impact's life over which its alpha ramps
   * to nothing.
   *
   * Story 11.1 released `render/` from the flat-surface rule, so an impact can
   * now die by fading rather than only by expiring. The ramp is carried as
   * integer basis points (`JuiceImpact.alphaBasisPoints`) and the single
   * division into a float happens at the `globalAlpha` assignment in
   * `juice-draw.ts` -- the same discipline `audio.ts` follows at its
   * `GainNode`.
   */
  readonly impactFadeFrames: Readonly<Record<JuiceKind, number>>;
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
  // Story 11.2 moved the three `lifeFrames` onto `impactFrames` below, so a
  // burst and the impact sprite struck at its contact point end together. The
  // counts themselves are unchanged.
  sparks: Object.freeze({
    hit: Object.freeze({ count: 6, lifeFrames: 12 }),
    heavy: Object.freeze({ count: 10, lifeFrames: 12 }),
    ko: Object.freeze({ count: 14, lifeFrames: 20 }),
  }),
  // These three numbers mirror `apps/web/public/fx/layout.json`: they are the
  // mapped pose's `frames * holdFrames`, which is how long that pose's art
  // actually takes to play. `spark_l` and `spark_h` are both 4 frames held 3
  // clock frames each; `ko_burst` is 5 held 4.
  impactFrames: Object.freeze({ hit: 12, heavy: 12, ko: 20 }),
  impactHeightPx: Object.freeze({ hit: 96, heavy: 104, ko: 116 }),
  impactSizePx: Object.freeze({ hit: 128, heavy: 176, ko: 260 }),
  impactFadeFrames: Object.freeze({ hit: 5, heavy: 5, ko: 8 }),
  damageNumberFrames: 24,
  damageNumberRisePx: 28,
  // 90 is the reference's own `CINEMATIC_FREEZE`, held by the renderer instead
  // of by the simulation. Story 11.4 lays the three acts out inside and past
  // it, on the reference's own tick numbers: letterbox in over 15, portrait
  // from 10, orb growing to 78 and blooming from 66, slam at 80, beam from 80
  // for 50 -- so the record runs 130 clock frames while the *freeze* stays 90.
  cinematic: Object.freeze({
    freezeFrames: 90,
    letterboxFrames: 15,
    letterboxHeightPx: 52,
    vignetteBasisPoints: 6_500,
    portraitFromFrame: 10,
    portraitFrames: 30,
    portraitWidthPx: 170,
    portraitHeightPx: 228,
    orbFrames: 78,
    orbMinPx: 3,
    orbMaxPx: 30,
    bloomFromFrame: 66,
    bloomFrames: 14,
    bloomBasisPoints: 22_000,
    slamFromFrame: 80,
    slamFrames: 10,
    slamTintBasisPoints: 4_000,
    releaseFromFrame: 80,
    releaseFrames: 50,
    beamSweepFrames: 8,
    beamThicknessPx: 36,
    impactScaleBasisPoints: 18_000,
    titleFromFrame: 10,
    titleFrames: 70,
    impactFrames: 22,
    impactMinBasisPoints: 2_187,
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
   * A square that shrank is the flat-block way to say "fading". When this was
   * written, actually fading it was not available: `style-discipline.test.ts`
   * banned any `globalAlpha` assignment other than `1` outside `backdrop.ts`.
   * **Story 11.1 released `render/` from that rule**, so a real alpha ramp is
   * now legal here. Shrinking stays until a drawing story replaces it on
   * purpose -- 11.2 owns impact FX. Nothing in this file is shrinking because
   * a rule still says so.
   */
  readonly sizePx: number;
}

/**
 * Story 11.2. One impact sprite, struck at the point of contact.
 *
 * **One per event, not one per spark**, and that is the whole shape of the
 * change. The squares above are scattered debris at deliberately *non*-contact
 * positions, and a 208px cell drawn at a 5px square's size is unreadable. So a
 * burst keeps its debris and gains a single sprite where the hit actually
 * landed -- which is also what the reference looks like frame by frame. That
 * is why `JuiceFrame` gains a list rather than `JuiceSpark` gaining fields.
 *
 * Nothing here names a file, a pose or an atlas frame. This module has no
 * sheet and no viewport; it says *what kind* of impact this is and how far
 * through its life it is, and `juice-draw.ts` -- which owns both -- turns that
 * into a source rect and a destination rect.
 */
export interface JuiceImpact {
  /** The grade of hit this came off. `juice-draw.ts` maps it to a pose. */
  readonly kind: JuiceKind;
  /** The contact point, in basis points across the arena. No scatter: this *is* the hit. */
  readonly positionBasisPoints: number;
  /** Height above the arena floor the sprite is centred at, in pixels. */
  readonly heightPx: number;
  /**
   * Clock frames since the hit landed.
   *
   * Handed on raw rather than pre-resolved to an atlas frame, because the
   * atlas's `holdFrames` lives in the layout beside the art and this module
   * has deliberately never read that file.
   */
  readonly ageFrames: number;
  /**
   * The fade, in integer basis points of full opacity.
   *
   * Basis points rather than a float for the reason the whole module gives:
   * `juice.ts` stays integer end to end and the single division happens at the
   * canvas boundary -- here, at `globalAlpha`, and nowhere earlier.
   */
  readonly alphaBasisPoints: number;
  /** The drawn size, in pixels, square. */
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

/**
 * Which of the three acts a cinematic frame belongs to (Story 11.4).
 *
 * Informational rather than a switch the drawing dispatches on -- every
 * quantity below is already zero outside its own window, so nothing has to ask.
 * It exists because "the Ultimate reads as three acts" is the story's first
 * acceptance criterion, and a criterion phrased about structure deserves an
 * assertion about structure rather than three about pixel counts.
 *
 * `slam` wins where it overlaps `release`: the beam fires on the same frame the
 * screen flashes, because in the reference the flash is what covers the cut
 * back to gameplay.
 */
export type CinematicAct = 'build' | 'slam' | 'release';

/** Everything the cinematic needs on one clock frame, or `null` on every other frame. */
export interface JuiceCinematic {
  readonly agentIndex: 0 | 1;
  readonly casterBasisPoints: number;
  readonly targetBasisPoints: number;
  readonly connected: boolean;
  /** Clock frames since the freeze opened. `0` on the one live frame. */
  readonly age: number;
  /**
   * Total clock frames this cinematic occupies.
   *
   * The freeze plus the live frame, **or** the release act's end, whichever is
   * later. Under the shipped tuning that is 130 rather than 91: the beam plays
   * over resumed playback for 50 frames after the slam.
   */
  readonly frames: number;
  /** Which act this frame belongs to. */
  readonly act: CinematicAct;
  /**
   * The letterbox bars' height on this frame, in pixels.
   *
   * Eased in on `easeOutBack` over `letterboxFrames`, held, and eased back out
   * from the slam -- so the bars are gone by the time the beam is sweeping and
   * the frame is a fight again rather than a cutscene with a beam in it.
   */
  readonly letterboxPx: number;
  /** The vignette's outer strength on this frame, in basis points of full opacity. */
  readonly vignetteBasisPoints: number;
  /** The energy orb's radius in pixels. `0` outside the build act. */
  readonly orbRadiusPx: number;
  /**
   * Extra orb scale from the bloom, in basis points. `0` until `bloomFromFrame`.
   *
   * Carried separately from `orbRadiusPx` rather than folded into it because
   * the two say different things to the drawing: the radius is the orb, and
   * this is the muzzle flash it becomes. `juice-draw.ts` draws the white core
   * only while this is rising.
   */
  readonly bloomBasisPoints: number;
  /**
   * How far the caster's portrait has slid in, in basis points, eased.
   *
   * `easeOutBack`, so it **exceeds** `BASIS_POINTS_FULL` mid-slide and settles
   * back. `0` before `portraitFromFrame`, which is what "not on screen yet"
   * means here.
   */
  readonly portraitBasisPoints: number;
  /** The portrait's drawn size in pixels, carried so the drawing has no size of its own. */
  readonly portraitWidthPx: number;
  readonly portraitHeightPx: number;
  /** How much of the caster's aura the slam plate mixes into white, in basis points. */
  readonly slamTintBasisPoints: number;
  /**
   * The slam plate's opacity on this frame, in basis points. `0` on every frame
   * outside the slam, which is what "no plate" means.
   *
   * Basis points rather than a boolean because the plate now falls off across
   * `slamFrames` instead of being painted solid -- see `CinematicTuning`.
   */
  readonly flashBasisPoints: number;
  /** This frame carries the title banner (the stand-in for an absent portrait). */
  readonly title: boolean;
  /**
   * How far the beam reaches from the caster, in basis points across the arena.
   * `0` draws nothing.
   *
   * Basis points rather than pixels, for the reason the whole module gives:
   * `juice-draw.ts` owns the one multiplication that turns this into a screen
   * coordinate, because it is the only file that has a viewport.
   *
   * Story 10.4 grew this from age zero as an impact *mark*; 11.4 makes it the
   * release act's sweep, so it is zero for the whole build and slam and then
   * sweeps to the arena edge on `easeOutCubic`. The two renderings of it -- a
   * sprite beam and 10.4's accent band -- read the same number.
   */
  readonly reachBasisPoints: number;
  /** The beam's thickness in pixels, and the height above the floor it fires at. */
  readonly beamThicknessPx: number;
  readonly beamHeightPx: number;
  /**
   * Where the beam terminates, in basis points: the target if the sweep has
   * reached them, otherwise the beam's leading edge.
   */
  readonly impactBasisPoints: number;
  /**
   * Whether the sweep currently covers the target.
   *
   * Distinct from `connected`, which is what the *simulation* did across the
   * Decision Point. Impact art needs both: a whiff must never draw one, and a
   * connecting Ultimate must not draw one before its beam has arrived.
   */
  readonly impactCovers: boolean;
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
  /**
   * Story 11.2. The impact sprites alive on this clock frame, in event order.
   *
   * Empty when no hit is in flight, and empty on every frame when the sheet
   * never loaded -- `juice-draw.ts` skips the whole list without a sheet, so
   * the track carries the same records either way and only the drawing
   * differs.
   */
  readonly impacts: readonly JuiceImpact[];
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
  impacts: Object.freeze([]),
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

/**
 * The impact sprite for one event at one age, or `null` once it has expired
 * (Story 11.2).
 *
 * A pure function of `(kind, age)` and the tuning. There is no pool, no
 * `Math.random()` and no per-effect state anywhere on this path: the reference
 * spawns these out of a stepped particle pool with its own RNG, and neither
 * survives here -- a pool cannot be scrubbed backwards and an ungoverned RNG
 * contradicts the claim that a replay reproduces.
 *
 * The alpha ramp is integer arithmetic and spans exactly `fadeFrames` frames.
 * It holds at full while more than `fadeFrames` remain, then falls in even
 * steps to **zero on the last live frame**: a `hit` (12 live, 5 fading) draws
 * `1 x7, 0.8, 0.6, 0.4, 0.2, 0`. Two off-by-ones are load-bearing here and
 * both were shipped wrong once:
 *
 * - `remaining - 1` in the numerator, so the ramp reaches zero rather than
 *   stopping at `FULL / fadeFrames` (20% for a `hit`) and blinking off from
 *   there. That blink is the pop this ramp exists to remove.
 * - `remaining > fadeFrames` rather than `>=` in the guard, so the first
 *   faded frame is one step down (0.8) instead of two (0.6). With `>=` the
 *   ramp opened on a 40% drop in a single frame -- a smaller pop, in the
 *   place a fade is supposed to be smoothest.
 *
 * The fade is a fixed tail measured back from the end of life and is
 * deliberately *not* aligned to the pose's cells: `fadeFrames` grades the
 * effect, the layout's `holdFrames` grades the art, and pinning either to the
 * other would make a retune of one silently retime the other.
 *
 * `fadeFrames` is clamped to `lifeFrames - 1`, not to `lifeFrames`. A tail as
 * long as the whole life leaves no frame on which `remaining > fadeFrames`
 * holds, so the sprite would open already dimmed -- 91.7% for a 12-frame `hit`
 * -- and never once draw at full brightness. That is a pop at the *start*, in
 * the same function whose two shipped defects were both pops, and it is
 * reachable by a retune rather than by an edit here: `buildJuiceTrack` takes
 * any `JuiceTuning`, and `juice.test.ts`'s `impactFadeFrames < impactFrames`
 * assertion only ever reads `DEFAULT_JUICE_TUNING`. The clamp makes the
 * degenerate table behave as the longest sane one instead.
 */
function impactFor(event: JuiceEvent, age: number, tuning: JuiceTuning): JuiceImpact | null {
  const lifeFrames = tuning.impactFrames[event.kind] ?? 0;
  if (age < 0 || age >= lifeFrames) {
    return null;
  }

  const fadeFrames = Math.max(
    0,
    Math.min(lifeFrames - 1, tuning.impactFadeFrames[event.kind] ?? 0),
  );
  const remaining = lifeFrames - age;
  const alphaBasisPoints =
    fadeFrames === 0 || remaining > fadeFrames
      ? BASIS_POINTS_FULL
      : Math.floor((BASIS_POINTS_FULL * (remaining - 1)) / fadeFrames);

  return Object.freeze({
    kind: event.kind,
    positionBasisPoints: event.positionBasisPoints,
    heightPx: Math.max(0, tuning.impactHeightPx[event.kind] ?? 0),
    ageFrames: age,
    alphaBasisPoints: Math.max(0, Math.min(BASIS_POINTS_FULL, alphaBasisPoints)),
    sizePx: Math.max(1, tuning.impactSizePx[event.kind] ?? 1),
  });
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
 * `1 - (1 - t)³`, in basis points (Story 11.4).
 *
 * The reference's `easeOutCubic`, which is what its beam sweeps out on. Written
 * as integer arithmetic rather than as floats for the reason the whole module
 * gives: every value on a `JuiceCinematic` is an integer, and the one division
 * into a float happens at the canvas boundary in `juice-draw.ts`.
 *
 * `u³` peaks at `1e12`, comfortably inside `Number.MAX_SAFE_INTEGER`, so this
 * one needs no staging.
 */
export function easeOutCubicBasisPoints(progress: number): number {
  const t = Math.max(0, Math.min(BASIS_POINTS_FULL, Math.floor(progress)));
  const u = BASIS_POINTS_FULL - t;
  // `ceil` on the subtracted term, so the *result* floors. Flooring the
  // subtrahend would round the curve upward, which puts the sweep one basis
  // point ahead of the value it is meant to be truncating toward.
  return BASIS_POINTS_FULL - Math.ceil((u * u * u) / 100_000_000);
}

/** `c1` and `c3` from the standard `easeOutBack`, in basis points: 1.70158 and 2.70158. */
const BACK_C1_BASIS_POINTS = 17_016;
const BACK_C3_BASIS_POINTS = 27_016;

/**
 * `1 + c3·(t-1)³ + c1·(t-1)²`, in basis points (Story 11.4).
 *
 * The overshooting ease the reference slides its letterbox bars and its
 * portrait in on. **Returns more than `BASIS_POINTS_FULL` mid-curve** -- it
 * peaks near `10_905` around `t = 0.66`, which is the overshoot and the whole
 * reason this curve rather than a cubic. Callers must not clamp the *output*.
 *
 * The multiplications are staged through an intermediate floor because they
 * would otherwise leave the safe-integer range: `c3 · u³` is `2.7e16` at the
 * endpoint and `Number.MAX_SAFE_INTEGER` is `9.0e15`. Dividing `u³` down by
 * `1e6` first keeps every intermediate under `2.7e10`, at a cost of a basis
 * point or two of precision in a value that becomes a pixel offset.
 */
export function easeOutBackBasisPoints(progress: number): number {
  const t = Math.max(0, Math.min(BASIS_POINTS_FULL, Math.floor(progress)));
  const u = t - BASIS_POINTS_FULL;
  const cubic = Math.floor((BACK_C3_BASIS_POINTS * Math.floor((u * u * u) / 1_000_000)) / 1_000_000);
  const square = Math.floor((BACK_C1_BASIS_POINTS * (u * u)) / 100_000_000);
  return BASIS_POINTS_FULL + cubic + square;
}

/** `numerator / denominator` as basis points, clamped to `0..BASIS_POINTS_FULL`. */
function progressBasisPointsOf(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return BASIS_POINTS_FULL;
  }
  const raw = Math.floor((Math.max(0, numerator) * BASIS_POINTS_FULL) / denominator);
  return Math.max(0, Math.min(BASIS_POINTS_FULL, raw));
}

/**
 * How far the beam reaches at full extension, in basis points.
 *
 * The reference's `fullLen = Math.max(420, edgeLen)`: the distance from the
 * caster to the arena edge they are facing, floored so a caster pinned against
 * that edge still fires something. **Not** the separation between the fighters
 * -- an Ultimate that stopped at the opponent would be a stick rather than a
 * beam, and the reference explicitly draws past them and flares where the two
 * meet.
 *
 * Story 10.4 derived this from the separation plus a fixed overshoot, because
 * what it was sizing was an impact *mark* rather than a beam. Same field, new
 * meaning; the overshoot tuning went with the old one.
 */
function fullReachFor(event: CinematicEvent, tuning: JuiceTuning): number {
  const shape = tuning.cinematic;
  const toward = event.targetBasisPoints >= event.casterBasisPoints ? 1 : -1;
  const toEdge =
    toward > 0 ? BASIS_POINTS_FULL - event.casterBasisPoints : event.casterBasisPoints;
  return Math.min(
    BASIS_POINTS_FULL,
    Math.max(Math.max(0, shape.impactMinBasisPoints), Math.max(0, toEdge)),
  );
}

/** Total clock frames a cinematic occupies: the freeze, or the release act, whichever ends later. */
function cinematicFramesFor(tuning: JuiceTuning): number {
  const shape = tuning.cinematic;
  return Math.max(
    Math.max(0, shape.freezeFrames) + 1,
    Math.max(0, shape.releaseFromFrame) + Math.max(0, shape.releaseFrames),
  );
}

/**
 * The whole cinematic record for one event at one age.
 *
 * `reducedMotion` is a parameter rather than a post-hoc rewrite of the finished
 * record, which is what Story 10.4's `stilled` was. Three acts' worth of fields
 * is too many for a patch function to stay honest about: every field 11.4 added
 * would have had to be remembered in a second place, and the one forgotten
 * would be a full-stage luminance change reaching a viewer who asked for less
 * motion. Here each quantity states its own reduced value beside its moving
 * one, so there is no second list to keep in step.
 *
 * What reduced motion switches off is the *motion*, never the beat: the track
 * keeps its frame count and its acts, the flash and the streak field go
 * entirely, and everything that would have moved is pinned at the value it
 * settles on.
 */
function cinematicAt(
  event: CinematicEvent,
  age: number,
  tuning: JuiceTuning,
  reducedMotion: boolean,
): JuiceCinematic {
  const shape = tuning.cinematic;
  const clampedAge = Math.max(0, age);

  // --- Act 3, the release. Zero until the beam fires, then swept out and held.
  const releaseAge = clampedAge - Math.max(0, shape.releaseFromFrame);
  const releasing = releaseAge >= 0 && releaseAge < Math.max(0, shape.releaseFrames);
  const sweep = releasing
    ? reducedMotion
      ? BASIS_POINTS_FULL
      : easeOutCubicBasisPoints(progressBasisPointsOf(releaseAge, Math.max(1, shape.beamSweepFrames)))
    : 0;
  const fullReach = fullReachFor(event, tuning);
  const reachBasisPoints = Math.floor((fullReach * sweep) / BASIS_POINTS_FULL);

  const toward = event.targetBasisPoints >= event.casterBasisPoints ? 1 : -1;
  const leadingEdge = event.casterBasisPoints + toward * reachBasisPoints;
  const separation = Math.abs(event.targetBasisPoints - event.casterBasisPoints);
  const impactCovers = releasing && reachBasisPoints >= separation;
  const impactBasisPoints = impactCovers ? event.targetBasisPoints : leadingEdge;

  // --- Act 2, the slam. One rise and one fall across `slamFrames`, no repeat.
  const slamAge = clampedAge - Math.max(0, shape.slamFromFrame);
  const slamming = !reducedMotion && slamAge >= 0 && slamAge < Math.max(0, shape.slamFrames);
  const flashBasisPoints = slamming
    ? BASIS_POINTS_FULL -
      progressBasisPointsOf(slamAge, Math.max(1, shape.slamFrames))
    : 0;

  // --- Act 1, the build. The orb grows on `age²` -- the reference's `growP *
  // growP` -- which is what makes the build accelerate into the bloom rather
  // than crawl toward it.
  const building = clampedAge < Math.max(0, shape.slamFromFrame);
  const growth = progressBasisPointsOf(clampedAge, Math.max(1, shape.orbFrames));
  const accelerated = reducedMotion
    ? BASIS_POINTS_FULL
    : Math.floor((growth * growth) / BASIS_POINTS_FULL);
  const orbSpanPx = Math.max(0, shape.orbMaxPx - shape.orbMinPx);
  const orbRadiusPx = building
    ? Math.max(0, shape.orbMinPx) + Math.floor((orbSpanPx * accelerated) / BASIS_POINTS_FULL)
    : 0;
  const bloomAge = clampedAge - Math.max(0, shape.bloomFromFrame);
  const bloomBasisPoints =
    building && bloomAge >= 0 && !reducedMotion
      ? Math.floor(
          (Math.max(0, shape.bloomBasisPoints) *
            progressBasisPointsOf(bloomAge, Math.max(1, shape.bloomFrames))) /
            BASIS_POINTS_FULL,
        )
      : 0;

  // --- Framing. The bars slide in on `easeOutBack`, hold, and retract from the
  // slam, so the beam plays over a stage rather than inside a cutscene.
  const letterboxFrames = Math.max(1, shape.letterboxFrames);
  const retractAge = clampedAge - Math.max(0, shape.slamFromFrame);
  const framingBasisPoints = reducedMotion
    ? retractAge >= letterboxFrames
      ? 0
      : BASIS_POINTS_FULL
    : retractAge >= 0
      ? BASIS_POINTS_FULL -
        easeOutCubicBasisPoints(progressBasisPointsOf(retractAge, letterboxFrames))
      : easeOutBackBasisPoints(progressBasisPointsOf(clampedAge, letterboxFrames));
  const letterboxPx = Math.max(
    0,
    Math.floor((Math.max(0, shape.letterboxHeightPx) * framingBasisPoints) / BASIS_POINTS_FULL),
  );
  const vignetteBasisPoints = Math.max(
    0,
    Math.floor(
      (Math.max(0, shape.vignetteBasisPoints) * Math.min(BASIS_POINTS_FULL, framingBasisPoints)) /
        BASIS_POINTS_FULL,
    ),
  );

  // --- The subject. Slides in from the caster's own side on `easeOutBack`,
  // and leaves with the bars.
  const portraitAge = clampedAge - Math.max(0, shape.portraitFromFrame);
  const portraitBasisPoints =
    portraitAge < 0 || letterboxPx === 0
      ? 0
      : reducedMotion
        ? BASIS_POINTS_FULL
        : easeOutBackBasisPoints(
            progressBasisPointsOf(portraitAge, Math.max(1, shape.portraitFrames)),
          );

  return Object.freeze({
    agentIndex: event.agentIndex,
    casterBasisPoints: event.casterBasisPoints,
    targetBasisPoints: event.targetBasisPoints,
    connected: event.connected,
    age,
    frames: cinematicFramesFor(tuning),
    act: building ? 'build' : slamAge < Math.max(0, shape.slamFrames) ? 'slam' : 'release',
    letterboxPx,
    vignetteBasisPoints,
    orbRadiusPx,
    bloomBasisPoints,
    portraitBasisPoints,
    portraitWidthPx: Math.max(0, shape.portraitWidthPx),
    portraitHeightPx: Math.max(0, shape.portraitHeightPx),
    slamTintBasisPoints: Math.max(
      0,
      Math.min(BASIS_POINTS_FULL, shape.slamTintBasisPoints),
    ),
    flashBasisPoints,
    title: age >= shape.titleFromFrame && age < shape.titleFromFrame + shape.titleFrames,
    reachBasisPoints,
    beamThicknessPx: Math.max(0, shape.beamThicknessPx),
    beamHeightPx: Math.max(0, shape.impactHeightPx),
    impactBasisPoints,
    impactCovers,
    bandPx: shape.impactBandPx,
    heightPx: shape.impactHeightPx,
    streaks: reducedMotion ? Object.freeze([]) : streaksFor(event, age, tuning),
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
      // Story 11.2. The impact is tuned to expire with its burst, but the two
      // are separate numbers in a hand-editable table: bucketing on the longer
      // of them is what keeps a retune that lengthens only the impact from
      // silently truncating it here.
      tuning.impactFrames[event.kind] ?? 0,
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
  //
  // Story 11.4: the span is the *record's* length, which is no longer the
  // freeze's. The release act plays on over resumed playback for 50 frames
  // after the slam -- exactly as the reference nulls `state.cinematic` at tick
  // 80 and lets its `beamWindow` run -- so bucketing on `freezeFrames + 1`
  // would cut the beam off on the frame it fired.
  const cinematicSpan = freezeFrames > 0 ? cinematicFramesFor(tuning) : 0;
  const cinematicByClock: (CinematicEvent | null)[] = filmIndexes.map(() => null);
  for (const cinematic of cinematicByFilmIndex.values()) {
    const start = cinematicStartedAt.get(cinematic);
    if (start === undefined) {
      continue;
    }
    const end = Math.min(filmIndexes.length, start + cinematicSpan);
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
        : cinematicAt(
            owner,
            clockIndex - (cinematicStartedAt.get(owner) ?? 0),
            tuning,
            reducedMotion,
          );
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
        // Reduced motion and the resting final frame drop the impact art for
        // the same reasons they drop the sparks: an additive full-brightness
        // flash is a luminance change, which is exactly what the preference is
        // for, and one left frozen on the last frame forever reads as a broken
        // layout rather than as a finished Match.
        impacts: Object.freeze([]),
        damageNumbers: Object.freeze([]),
        // The final clock frame drops the cinematic entirely, for the same
        // reason it drops the shake: playback rests there indefinitely, and a
        // title banner or a half-drawn beam left on screen forever reads as a
        // broken layout rather than as a finished Match.
        //
        // Story 11.4: the reduced-motion record is built by `cinematicAt`
        // itself rather than patched here afterwards, so there is no second
        // list of fields to keep in step with the first.
        cinematic: clockIndex === lastClockIndex ? null : cinematic,
      });
    }

    const sparks: JuiceSpark[] = [];
    // Story 11.2. One per live event, in the order `deriveJuiceEvents` emitted
    // them -- so a trade draws both fighters' impacts, and always in the same
    // order, which is what makes the call sequence a function of the frame
    // index rather than of how the events were bucketed.
    const impacts: JuiceImpact[] = [];
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
      const impact = impactFor(event, age, tuning);
      if (impact !== null) {
        impacts.push(impact);
      }
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
      impacts: Object.freeze(impacts),
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
