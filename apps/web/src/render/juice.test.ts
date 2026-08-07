import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_NONE,
  PHASE_IDLE,
  ZONE_NONE,
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { BASIS_POINTS_FULL, FRAMES_PER_DECISION, type RenderFrame } from '../replay/film';
import { buildReplayFilm } from '../replay/film';
import { buildDemoLog } from '../testing/demo-log';
import { createPlaybackClock } from '../player/clock';
import {
  DEFAULT_JUICE_TUNING,
  buildJuiceTrack,
  deriveJuiceEvents,
  shakeTierFor,
  type JuiceKind,
  type JuiceTuning,
} from './juice';
import { validateVfxSheetLayout } from './vfx-sheet';
// The real mapping, not a copy of it: this guard is about the tuning agreeing
// with the art, and a hand-written mirror here would survive the remap it is
// supposed to catch.
import { POSE_FOR_KIND } from './juice-draw';

/**
 * Story 9.5, the derivation half.
 *
 * Every case here runs on hand-built films rather than on the demo Match,
 * because the properties worth pinning are about *edges* -- a whiff, a KO, a
 * damage value below the lowest curve tier, an empty film -- and a real Match
 * contains whichever of those it happens to contain. The demo film appears in
 * exactly one case, the one that has to be about a real film: seek-equals-play.
 *
 * There is no fake timer anywhere in this file, and there is nothing to fake:
 * the only driver is `createPlaybackClock` with a `requestFrame` that is a
 * plain function call. Counting callbacks is the whole mechanism.
 */

function stateWith(overrides: Partial<FighterState> = {}): FighterState {
  return {
    tick: 0,
    rngState: 1,
    health: [100, 100],
    position: [320, 640],
    meter: [0, 0],
    commitmentRemaining: [0, 0],
    committedAction: [COMMITTED_NONE, COMMITTED_NONE],
    windowHitLanded: [0, 0],
    verticalPosition: [0, 0],
    airState: [PHASE_IDLE, PHASE_IDLE],
    committedZone: [ZONE_NONE, ZONE_NONE],
    juggleCount: [0, 0],
    ...overrides,
  };
}

/**
 * Expands a list of `(from, to)` pairs into a film with the real frame layout.
 *
 * Deliberately mirrors `film.ts`'s `toFrames`: every frame of a Decision Point
 * shares one state pair, and only the first carries
 * `progressBasisPoints === 0`. That layout is what `deriveJuiceEvents` keys
 * off, so a helper that flattened it would test a film shape the player never
 * sees.
 */
function filmOf(steps: readonly (readonly [FighterState, FighterState])[]): readonly RenderFrame[] {
  const frames: RenderFrame[] = [];
  for (const [step, pair] of steps.entries()) {
    for (let offset = 0; offset < FRAMES_PER_DECISION; offset += 1) {
      frames.push({
        index: step * FRAMES_PER_DECISION + offset,
        decisionPoint: step,
        progressBasisPoints: Math.floor((offset * BASIS_POINTS_FULL) / FRAMES_PER_DECISION),
        from: pair[0],
        to: pair[1],
      });
    }
  }
  return frames;
}

/** One Decision Point in which agent 1 loses `damage` health, then one quiet one. */
function hitFilm(damage: number, finalHealth = 100 - damage): readonly RenderFrame[] {
  const before = stateWith({ health: [100, 100] });
  const after = stateWith({ health: [100, finalHealth], tick: 30 });
  return filmOf([
    [before, after],
    [after, after],
  ]);
}

describe('deriving the event stream from the film (AC1)', () => {
  it('fires one event per hit, on the frame the Decision Point opens', () => {
    const events = deriveJuiceEvents(hitFilm(9));

    // One, not twelve. Every frame inside a Decision Point carries the same
    // `from`/`to` pair, so a naive per-frame diff would fire the same hit once
    // per frame and produce a shake that never ended.
    expect(events).toHaveLength(1);
    expect(events[0].filmIndex).toBe(0);
    expect(events[0].damage).toBe(9);
    expect(events[0].agentIndex).toBe(1);
    expect(events[0].kind).toBe('hit');
  });

  it('places the event where the struck fighter stood, in basis points', () => {
    const before = stateWith({ health: [100, 100], position: [0, 480] });
    const after = stateWith({ health: [100, 92], position: [0, 480] });
    const [event] = deriveJuiceEvents(filmOf([[before, after]]));

    // Halfway across a 0..960 arena.
    expect(event.positionBasisPoints).toBe(BASIS_POINTS_FULL / 2);
  });

  it('centres the effect rather than producing NaN on a degenerate arena', () => {
    const [event] = deriveJuiceEvents(hitFilm(9), DEFAULT_JUICE_TUNING, { min: 5, max: 5 });

    expect(Number.isNaN(event.positionBasisPoints)).toBe(false);
    expect(event.positionBasisPoints).toBe(BASIS_POINTS_FULL / 2);
  });

  it('produces nothing at all for a whiff', () => {
    const same = stateWith();
    expect(deriveJuiceEvents(filmOf([[same, same]]))).toStrictEqual([]);
    expect(buildJuiceTrack(filmOf([[same, same]])).frameCount).toBe(FRAMES_PER_DECISION);
  });

  it('grades a big hit as heavy and a fatal one as a KO', () => {
    expect(deriveJuiceEvents(hitFilm(20))[0].kind).toBe('heavy');
    // Health reaching zero outranks the damage value entirely: a three-point
    // chip that finishes a fighter is a KO, not a light hit, even though its
    // damage sits in the lowest curve tier.
    const fatal = deriveJuiceEvents(
      filmOf([[stateWith({ health: [100, 3] }), stateWith({ health: [100, 0] })]]),
    );
    expect(fatal[0].kind).toBe('ko');
    expect(fatal[0].damage).toBe(3);
  });

  it('fires once per fighter when both take damage in one Decision Point', () => {
    const before = stateWith({ health: [100, 100] });
    const after = stateWith({ health: [88, 91] });
    const events = deriveJuiceEvents(filmOf([[before, after]]));

    expect(events.map((event) => event.agentIndex)).toStrictEqual([0, 1]);
    expect(events.map((event) => event.damage)).toStrictEqual([12, 9]);
  });
});

describe('the damage-keyed shake curve (AC2)', () => {
  it('reads every magnitude from the table, with no literal at a call site', () => {
    // The property AC2 actually asks for: a bigger hit shakes strictly harder,
    // and the numbers involved are the table's own.
    const light = shakeTierFor(DEFAULT_JUICE_TUNING, 4);
    const heavy = shakeTierFor(DEFAULT_JUICE_TUNING, 30);

    expect(heavy.magnitude).toBeGreaterThan(light.magnitude);
    expect(DEFAULT_JUICE_TUNING.shakeCurve).toContain(light);
    expect(DEFAULT_JUICE_TUNING.shakeCurve).toContain(heavy);
  });

  it('clamps below the lowest tier and above the highest, never negative or unbounded', () => {
    const curve = DEFAULT_JUICE_TUNING.shakeCurve;

    expect(shakeTierFor(DEFAULT_JUICE_TUNING, -50)).toBe(curve[0]);
    expect(shakeTierFor(DEFAULT_JUICE_TUNING, 0)).toBe(curve[0]);
    expect(shakeTierFor(DEFAULT_JUICE_TUNING, 10_000)).toBe(curve[curve.length - 1]);
  });

  it('survives an empty curve instead of throwing on it', () => {
    const bare: JuiceTuning = { ...DEFAULT_JUICE_TUNING, shakeCurve: [] };
    expect(shakeTierFor(bare, 12).magnitude).toBe(0);
    expect(buildJuiceTrack(hitFilm(12), bare).at(0).shakeX).toBe(0);
  });

  it('shakes harder for the bigger of two hits, and decays to nothing on both', () => {
    const magnitudeOver = (damage: number): readonly number[] => {
      const track = buildJuiceTrack(hitFilm(damage));
      return Array.from({ length: track.frameCount }, (_unused, index) =>
        Math.abs(track.at(index).shakeX) + Math.abs(track.at(index).shakeY),
      );
    };

    const light = magnitudeOver(4);
    const heavy = magnitudeOver(30);

    expect(Math.max(...heavy)).toBeGreaterThan(Math.max(...light));
    // And both end still: a shake that never settled would be a stage that
    // never stopped moving for the rest of the Match.
    expect(light[light.length - 1]).toBe(0);
    expect(heavy[heavy.length - 1]).toBe(0);
  });

  it('is deterministic: the same film shakes identically every time it is built', () => {
    const first = buildJuiceTrack(hitFilm(20));
    const second = buildJuiceTrack(hitFilm(20));

    for (let index = 0; index < first.frameCount; index += 1) {
      expect(first.at(index)).toStrictEqual(second.at(index));
    }
  });
});

describe('hitstop, counted in callbacks and nothing else (AC1)', () => {
  it('holds the film index for exactly the tuned frame count, then resumes on the next', () => {
    const track = buildJuiceTrack(hitFilm(20));
    const hold = DEFAULT_JUICE_TUNING.hitstopFrames.heavy;

    // Clock frame 0 presents film frame 0 and the hit lands there.
    expect(track.filmIndexAt(0)).toBe(0);
    for (let held = 1; held <= hold; held += 1) {
      expect(track.filmIndexAt(held)).toBe(0);
      expect(track.at(held).frozen).toBe(true);
    }
    // Resumes on the very next film frame -- never skipping one.
    expect(track.filmIndexAt(hold + 1)).toBe(1);
    expect(track.at(hold + 1).frozen).toBe(false);
  });

  it('lengthens the clock by exactly the hold, and the film not at all', () => {
    const frames = hitFilm(20);
    const track = buildJuiceTrack(frames);

    expect(track.frameCount).toBe(frames.length + DEFAULT_JUICE_TUNING.hitstopFrames.heavy);
    // Every film frame is still presented, in order, exactly once as a live
    // frame. Hitstop repeats a frame; it never drops one.
    const live = Array.from({ length: track.frameCount }, (_unused, index) => index)
      .filter((index) => !track.at(index).frozen)
      .map((index) => track.filmIndexAt(index));
    expect(live).toStrictEqual(frames.map((frame) => frame.index));
  });

  it('takes the longer freeze when both fighters are hit at once, never the sum', () => {
    const before = stateWith({ health: [100, 100] });
    const after = stateWith({ health: [96, 70] });
    const frames = filmOf([
      [before, after],
      [after, after],
    ]);

    expect(buildJuiceTrack(frames).frameCount).toBe(
      frames.length + DEFAULT_JUICE_TUNING.hitstopFrames.heavy,
    );
  });

  it('gives a KO the longest hold of the three kinds', () => {
    const { hitstopFrames } = DEFAULT_JUICE_TUNING;
    expect(hitstopFrames.ko).toBeGreaterThan(hitstopFrames.heavy);
    expect(hitstopFrames.heavy).toBeGreaterThan(hitstopFrames.hit);
  });

  it('freezes for the tuned count of real callbacks, with no time elapsing', () => {
    // The AC in its literal form: drive a fake `requestFrame`, count the
    // callbacks, and assert the film index does not move for exactly the
    // tuned number of them. Nothing here reads a clock, so nothing here can
    // depend on how fast this test ran.
    const track = buildJuiceTrack(hitFilm(20));
    const presented: number[] = [];
    const pending: (() => void)[] = [];

    const clock = createPlaybackClock({
      frameCount: track.frameCount,
      requestFrame: (callback) => {
        pending.push(callback);
        return pending.length;
      },
      onFrame: (index) => presented.push(track.filmIndexAt(index)),
    });

    clock.start();
    while (pending.length > 0) {
      pending.shift()?.();
    }

    const hold = DEFAULT_JUICE_TUNING.hitstopFrames.heavy;
    expect(presented.slice(0, hold + 1)).toStrictEqual(Array<number>(hold + 1).fill(0));
    expect(presented[hold + 1]).toBe(1);
    expect(presented).toHaveLength(track.frameCount);
  });
});

describe('sparks and floating numbers (AC3)', () => {
  it('draws both at the struck fighter, and both vanish after their tuned life', () => {
    const track = buildJuiceTrack(hitFilm(9));
    const [event] = track.events;
    const burst = DEFAULT_JUICE_TUNING.sparks.hit;

    expect(track.at(0).sparks).toHaveLength(burst.count);
    expect(track.at(0).damageNumbers).toHaveLength(1);
    expect(track.at(0).damageNumbers[0].damage).toBe(9);
    // The burst is centred on the impact point: every square carries the
    // struck fighter's own position, and scatters from it by a pixel offset
    // `juice-draw.ts` applies once it has a viewport.
    for (const spark of track.at(0).sparks) {
      expect(spark.positionBasisPoints).toBe(event.positionBasisPoints);
      // At age 0 the spread multiplier is 1, so the bound is the raw scatter.
      expect(Math.abs(spark.offsetPx)).toBeLessThanOrEqual(22);
    }

    // Exactly at the lifetime, not one frame later.
    expect(track.at(burst.lifeFrames - 1).sparks.length).toBeGreaterThan(0);
    expect(track.at(burst.lifeFrames).sparks).toStrictEqual([]);
    expect(track.at(DEFAULT_JUICE_TUNING.damageNumberFrames - 1).damageNumbers).toHaveLength(1);
    expect(track.at(DEFAULT_JUICE_TUNING.damageNumberFrames).damageNumbers).toStrictEqual([]);
  });

  it('never lets a spark fall below the floor or leave the top of the stage', () => {
    // Scatter is multiplied by age, so the tail of a burst is where an
    // unbounded rise escapes: measured on the demo film, the raw offsets
    // reached -124 and +316 against a 360px-tall stage. Below the floor is a
    // square under the ground; above the stage is a square nobody sees.
    for (const damage of [4, 20, 100]) {
      const track = buildJuiceTrack(hitFilm(damage, Math.max(0, 100 - damage)));
      for (let index = 0; index < track.frameCount; index += 1) {
        for (const spark of track.at(index).sparks) {
          expect(spark.heightPx).toBeGreaterThanOrEqual(0);
          expect(spark.heightPx).toBeLessThanOrEqual(240);
        }
      }
    }
  });

  it('gives a KO a bigger burst than a chip hit, per kind', () => {
    const { sparks } = DEFAULT_JUICE_TUNING;

    expect(sparks.heavy.count).toBeGreaterThan(sparks.hit.count);
    expect(sparks.ko.count).toBeGreaterThan(sparks.heavy.count);
    // Lifetime grades between a KO and an ordinary hit, and **not** between a
    // light hit and a heavy one. Story 11.2 pinned every burst to its impact
    // sprite's `frames x holdFrames` so the debris and the flash end together,
    // and the sheet draws `spark_l` and `spark_h` at the same 4 cells x 3
    // frames -- so both ordinary grades are 12 and only `ko_burst` (5 x 4) is
    // longer. The count is what still separates a light hit from a heavy one,
    // which is the cue that reads at a glance; an assertion that a heavy hit
    // must also last *longer* was never the grading this table was for, and
    // keeping it would mean the squares outliving the art they belong to.
    expect(sparks.heavy.lifeFrames).toBe(sparks.hit.lifeFrames);
    expect(sparks.ko.lifeFrames).toBeGreaterThan(sparks.heavy.lifeFrames);

    // And the tuning is actually consulted, rather than one burst shape being
    // shared by every kind.
    expect(buildJuiceTrack(hitFilm(4)).at(0).sparks).toHaveLength(sparks.hit.count);
    expect(buildJuiceTrack(hitFilm(20)).at(0).sparks).toHaveLength(sparks.heavy.count);
    expect(buildJuiceTrack(hitFilm(100, 0)).at(0).sparks).toHaveLength(sparks.ko.count);
  });

  it('keeps only the most recent number per fighter, so two never overlap', () => {
    // `damageNumberFrames` (24) outlives a Decision Point (12 frames), so
    // consecutive hits on one fighter used to draw two opaque numbers about
    // 14px apart -- both unreadable. The newer hit is the one being looked at.
    const a = stateWith({ health: [100, 100] });
    const b = stateWith({ health: [100, 91] });
    const c = stateWith({ health: [100, 78] });
    const track = buildJuiceTrack(
      filmOf([
        [a, b],
        [b, c],
        [c, c],
      ]),
    );

    expect(track.events).toHaveLength(2);
    for (let index = 0; index < track.frameCount; index += 1) {
      expect(track.at(index).damageNumbers.length).toBeLessThanOrEqual(1);
    }
    // And once the second lands, it is the second that is shown -- the first
    // never reappears on a later frame, which is the property the "most recent
    // wins" rule actually promises.
    const perFrame = Array.from({ length: track.frameCount }, (_unused, index) =>
      track.at(index).damageNumbers[0]?.damage,
    );
    const shown = perFrame.filter((damage) => damage !== undefined);
    expect(shown).toContain(9);
    expect(shown).toContain(13);
    expect(shown[shown.length - 1]).toBe(13);

    const secondStart = perFrame.indexOf(13);
    expect(secondStart).toBeGreaterThan(0);
    expect(perFrame.slice(secondStart)).not.toContain(9);
  });

  it('drifts the number upward across its life', () => {
    const track = buildJuiceTrack(hitFilm(9));
    const first = track.at(0).damageNumbers[0];
    const last = track.at(DEFAULT_JUICE_TUNING.damageNumberFrames - 1).damageNumbers[0];

    expect(last.heightPx).toBeGreaterThan(first.heightPx);
    expect(last.damage).toBe(first.damage);
  });

  it('shrinks a spark as it ages rather than making it translucent', () => {
    // `docs/DESIGN.md` bans translucency and `style-discipline.test.ts`
    // enforces it, so "fading out" has to be expressed in geometry. It still
    // has to actually happen, or a burst would pop out of existence at full
    // size.
    const track = buildJuiceTrack(hitFilm(9));
    const born = track.at(0).sparks;
    const dying = track.at(DEFAULT_JUICE_TUNING.sparks.hit.lifeFrames - 1).sparks;

    expect(dying).toHaveLength(born.length);
    for (const [index, spark] of dying.entries()) {
      expect(spark.sizePx).toBeLessThan(born[index].sizePx);
      expect(spark.sizePx).toBeGreaterThan(0);
    }
  });
});

describe('shake behaviour under the cases that used to double or stick', () => {
  it('decorrelates two simultaneous same-tier hits instead of doubling one offset', () => {
    // Both fighters take the same damage on the same Decision Point. Seeded on
    // `(clockIndex, magnitude)` the two events produced the *identical* offset
    // and summed to exactly 2x before clamping -- a doubled, saturating kick
    // that read as one bug shared between two fighters. Seeded on the event's
    // identity they disagree, so the sum is a blend rather than a doubling.
    const before = stateWith({ health: [100, 100] });
    const after = stateWith({ health: [70, 70] });
    const both = buildJuiceTrack(
      filmOf([
        [before, after],
        [after, after],
      ]),
    );
    const one = buildJuiceTrack(hitFilm(30));

    // Over the whole decay, the pair's offset is a *blend* of two disagreeing
    // jitters, not a doubling of one. A stray frame can still land on exactly
    // twice the solo value by coincidence -- the offsets are small integers --
    // so the property asserted is that most frames do not.
    const shaking = Array.from({ length: both.frameCount }, (_unused, index) => index).filter(
      (index) => one.at(index).shakeX !== 0,
    );
    const doubled = shaking.filter((index) => both.at(index).shakeX === one.at(index).shakeX * 2);

    expect(shaking.length).toBeGreaterThan(8);
    expect(doubled.length * 2).toBeLessThan(shaking.length);
    // Also not vacuous in the other direction: the pair does move the stage.
    expect(shaking.some((index) => both.at(index).shakeX !== 0)).toBe(true);
  });

  it('rests still on the very last clock frame, whatever landed there', () => {
    // A KO on the final Decision Point used to leave the stage permanently
    // offset by its shake, with a damage number frozen mid-rise -- an end
    // state that reads as a broken layout rather than as a finished Match.
    const before = stateWith({ health: [100, 40] });
    const after = stateWith({ health: [100, 0] });
    const track = buildJuiceTrack(filmOf([[before, after]]));
    const last = track.at(track.frameCount - 1);

    expect(last.shakeX).toBe(0);
    expect(last.shakeY).toBe(0);
    expect(last.sparks).toStrictEqual([]);
    expect(last.damageNumbers).toStrictEqual([]);
    // The film index it rests on is unchanged: only the juice is zeroed, so
    // the last clock frame still presents the last film frame.
    expect(track.filmIndexAt(track.frameCount - 1)).toBe(FRAMES_PER_DECISION - 1);
    expect(track.filmIndexAt(track.frameCount - 1)).toBe(last.filmIndex);
    expect(last.filmIndex).toBe(FRAMES_PER_DECISION - 1);
  });

  it('gives a reduced-motion viewer a still stage without changing the mapping', () => {
    // Declining to autoplay is only half the promise: camera shake is the
    // canonical vestibular trigger, and a visitor who scrubs would otherwise
    // get the full damage-scaled kick. The clock→film mapping stays identical
    // so the transport, the scrub range and every index assertion are
    // unaffected by the preference.
    const frames = hitFilm(30);
    const full = buildJuiceTrack(frames, DEFAULT_JUICE_TUNING, undefined, false);
    const calm = buildJuiceTrack(frames, DEFAULT_JUICE_TUNING, undefined, true);

    expect(calm.frameCount).toBe(full.frameCount);
    for (let index = 0; index < calm.frameCount; index += 1) {
      expect(calm.filmIndexAt(index)).toBe(full.filmIndexAt(index));
      expect(calm.at(index).frozen).toBe(full.at(index).frozen);
      expect(calm.at(index).shakeX).toBe(0);
      expect(calm.at(index).shakeY).toBe(0);
      expect(calm.at(index).sparks).toStrictEqual([]);
      expect(calm.at(index).damageNumbers).toStrictEqual([]);
    }
    // Not vacuous: the same film with motion allowed does shake.
    expect(
      Array.from({ length: full.frameCount }, (_unused, index) =>
        Math.abs(full.at(index).shakeX),
      ).some((magnitude) => magnitude > 0),
    ).toBe(true);
  });
});

describe('grading damage that lands after the fighter is already down', () => {
  it('fires nothing when the struck fighter was already at or below zero', () => {
    // A post-KO tick that shaves health off a fighter already on the floor is
    // not a hit the viewer should feel: grading it by damage fired a fresh
    // `hit`/`heavy` -- shake, sparks, a number -- on top of the KO that had
    // already played, which read as the KO not having landed.
    const down = stateWith({ health: [100, 0] });
    const lower = stateWith({ health: [100, -8] });
    const events = deriveJuiceEvents(filmOf([[down, lower]]));

    expect(events).toStrictEqual([]);

    // The killing blow itself still fires, exactly once.
    const alive = stateWith({ health: [100, 5] });
    const killed = deriveJuiceEvents(
      filmOf([
        [alive, down],
        [down, lower],
      ]),
    );
    expect(killed).toHaveLength(1);
    expect(killed[0].kind).toBe('ko');
  });
});

describe('the shake curve does not trust the order it was written in', () => {
  it('grades correctly on a deliberately out-of-order, hand-edited table', () => {
    // The table is advertised as hand-editable, so "rows ascend by
    // `minDamage`" and "the last row is the biggest" are assumptions a later
    // append can quietly break. Selection is by highest `minDamage` at or
    // below the damage; a KO takes the largest *magnitude*.
    const scrambled: JuiceTuning = {
      ...DEFAULT_JUICE_TUNING,
      shakeCurve: [
        { minDamage: 24, magnitude: 14, frames: 24 },
        { minDamage: 0, magnitude: 6, frames: 4 },
        { minDamage: 12, magnitude: 10, frames: 16 },
      ],
    };

    expect(shakeTierFor(scrambled, -5).magnitude).toBe(6);
    expect(shakeTierFor(scrambled, 0).magnitude).toBe(6);
    expect(shakeTierFor(scrambled, 12).magnitude).toBe(10);
    expect(shakeTierFor(scrambled, 23).magnitude).toBe(10);
    expect(shakeTierFor(scrambled, 10_000).magnitude).toBe(14);

    // And a KO on this table still takes the biggest tier, even though it is
    // written first and the killing blow's damage is tiny.
    const peak = (frames: readonly RenderFrame[]): number => {
      const track = buildJuiceTrack(frames, scrambled);
      return Math.max(
        ...Array.from({ length: track.frameCount }, (_unused, index) =>
          Math.abs(track.at(index).shakeX) + Math.abs(track.at(index).shakeY),
        ),
      );
    };

    const fatal = filmOf([
      [stateWith({ health: [100, 2] }), stateWith({ health: [100, 0] })],
      [stateWith({ health: [100, 0] }), stateWith({ health: [100, 0] })],
    ]);
    expect(peak(fatal)).toBeGreaterThan(peak(hitFilm(2)));
  });
});

describe('the track is a table, so seeking and playing cannot disagree', () => {
  it('answers identically whether a frame was reached by playing or by jumping', async () => {
    const film = buildReplayFilm(await buildDemoLog(), createFighterEnvironment());
    const track = buildJuiceTrack(film.frames);

    // Played: every frame in order, keeping what each one said.
    const played = Array.from({ length: track.frameCount }, (_unused, index) => track.at(index));
    // Seeked: the same frames asked for out of order, and backwards.
    for (const index of [track.frameCount - 1, 0, 137, 42, 300, 12]) {
      const target = Math.min(index, track.frameCount - 1);
      expect(track.at(target)).toStrictEqual(played[target]);
    }
  });

  it('proves the demo Match actually exercises hitstop, so the case above is not vacuous', async () => {
    const film = buildReplayFilm(await buildDemoLog(), createFighterEnvironment());
    const track = buildJuiceTrack(film.frames);

    expect(track.events.length).toBeGreaterThan(0);
    expect(track.frameCount).toBeGreaterThan(film.frames.length);
  });
});

describe('degenerate inputs are clamped, never thrown on', () => {
  it('gives an empty film a zero-length track and a neutral frame', () => {
    const track = buildJuiceTrack([]);

    expect(track.frameCount).toBe(0);
    expect(track.filmIndexAt(0)).toBe(0);
    expect(track.at(0).sparks).toStrictEqual([]);
    expect(track.at(0).shakeX).toBe(0);
    expect(track.at(-1).frozen).toBe(false);
    expect(track.at(9_999).damageNumbers).toStrictEqual([]);
  });

  it('clamps an out-of-range index to the film ends', () => {
    const track = buildJuiceTrack(hitFilm(9));

    expect(track.at(-1)).toStrictEqual(track.at(0));
    expect(track.at(track.frameCount + 5)).toStrictEqual(track.at(track.frameCount - 1));
    expect(track.filmIndexAt(-1)).toBe(0);
    expect(track.filmIndexAt(Number.NaN)).toBe(0);
    expect(track.filmIndexAt(track.frameCount + 5)).toBe(
      track.filmIndexAt(track.frameCount - 1),
    );
  });
});

/**
 * Story 11.2. The impact record: what a hit is drawn *as*, not when one exists.
 *
 * `impactFor` never sees a sheet, a pose or a file. It answers with a kind, a
 * contact point, an age in clock frames and an integer alpha, and
 * `juice-draw.ts` -- which owns the sheet and the viewport -- turns that into
 * pixels. So the cases here are about the numbers only: that they are a pure
 * function of the frame index, that they end when their burst does, and that
 * they agree with the art actually on disk.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SHIPPED_FX_LAYOUT = join(REPO, 'apps', 'web', 'public', 'fx', 'layout.json');

describe('impacts, one per hit, at the point of contact (Story 11.2)', () => {
  it('emits exactly one impact per event, not one per spark', () => {
    // The shape of the whole change. The squares are scattered debris at
    // deliberately non-contact positions; a 208px cell drawn at a 5px square's
    // size is unreadable, so the burst keeps its debris and gains a *single*
    // sprite where the hit landed.
    const track = buildJuiceTrack(hitFilm(9));
    const frame = track.at(0);

    expect(frame.impacts).toHaveLength(1);
    expect(frame.sparks.length).toBeGreaterThan(1);
    expect(frame.impacts[0].kind).toBe('hit');
    expect(frame.impacts[0].positionBasisPoints).toBe(track.events[0].positionBasisPoints);
    // No scatter: this *is* the contact point, unlike a spark's `offsetPx`.
    expect(frame.impacts[0].positionBasisPoints).toBe(frame.sparks[0].positionBasisPoints);
  });

  it('grades the impact the same way the event was graded', () => {
    const kinds = ([9, 24] as const).map((damage) => buildJuiceTrack(hitFilm(damage)).at(0).impacts[0].kind);
    expect(kinds).toStrictEqual(['hit', 'heavy']);

    // And a killing blow is a KO however small it was: the Match's last hit
    // must not be drawn like its first.
    const ko = buildJuiceTrack(
      filmOf([
        [stateWith({ health: [100, 2] }), stateWith({ health: [100, 0], tick: 30 })],
        [stateWith({ health: [100, 0], tick: 30 }), stateWith({ health: [100, 0], tick: 60 })],
      ]),
    );
    expect(ko.at(0).impacts[0].kind).toBe('ko');
  });

  it('ages one clock frame at a time, holding position and size', () => {
    const track = buildJuiceTrack(hitFilm(9));
    const ages: number[] = [];
    for (let index = 0; index < track.frameCount; index += 1) {
      for (const impact of track.at(index).impacts) {
        ages.push(impact.ageFrames);
      }
    }
    // 0,1,2,... with no gap and no repeat: the age is a subtraction from the
    // frame the hit landed on, never a counter that was stepped.
    expect(ages).toStrictEqual(ages.map((_unused, index) => index));
    expect(ages[0]).toBe(0);
  });

  it('expires with its burst, on the same clock frame', () => {
    // The two are separate numbers in a hand-editable table and they are tuned
    // to agree. Debris that outlived the flash that threw it would read as two
    // unrelated effects.
    for (const damage of [9, 24] as const) {
      const track = buildJuiceTrack(hitFilm(damage));
      const lastImpact = lastIndexWhere(track, (frame) => frame.impacts.length > 0);
      const lastSpark = lastIndexWhere(track, (frame) => frame.sparks.length > 0);
      expect(lastImpact).toBe(lastSpark);
      expect(lastImpact).toBeGreaterThan(0);
    }
  });

  it('lives for exactly impactFrames clock frames and then stops', () => {
    const track = buildJuiceTrack(hitFilm(9));
    const alive = countWhere(track, (frame) => frame.impacts.length > 0);
    expect(alive).toBe(DEFAULT_JUICE_TUNING.impactFrames.hit);
    expect(track.at(DEFAULT_JUICE_TUNING.impactFrames.hit).impacts).toStrictEqual([]);
  });

  it('carries an integer alpha in basis points that falls to nothing at the end', () => {
    // `juice.ts` stays integer end to end -- the same discipline `audio.ts`
    // follows, where the single division into a float happens at the
    // `GainNode`. Here it happens at the `globalAlpha` assignment in
    // `juice-draw.ts` and nowhere earlier.
    const track = buildJuiceTrack(hitFilm(9));
    const alphas: number[] = [];
    for (let index = 0; index < track.frameCount; index += 1) {
      for (const impact of track.at(index).impacts) {
        expect(Number.isInteger(impact.alphaBasisPoints)).toBe(true);
        expect(impact.alphaBasisPoints).toBeGreaterThanOrEqual(0);
        expect(impact.alphaBasisPoints).toBeLessThanOrEqual(BASIS_POINTS_FULL);
        alphas.push(impact.alphaBasisPoints);
      }
    }

    // The whole sequence, spelled out, rather than a shape it satisfies.
    // Monotonic-and-ends-at-zero was the weaker assertion and it was blind to
    // both defects this ramp has actually shipped: ending at 20% and blinking
    // off, and opening the fade with a 40% drop in one frame. A `hit` lives
    // 12 frames and fades over the last 5, so full alpha holds for 7 and then
    // steps evenly to zero.
    const { hit } = DEFAULT_JUICE_TUNING.impactFrames;
    const fade = DEFAULT_JUICE_TUNING.impactFadeFrames.hit;
    const expected = [
      ...Array.from({ length: hit - fade }, () => BASIS_POINTS_FULL),
      8000, 6000, 4000, 2000, 0,
    ];
    expect(alphas).toStrictEqual(expected);
  });

  it('is a pure function of the frame index: two builds agree exactly', () => {
    // The scrub property at the derivation layer. No pool, no `Math.random()`,
    // no module-level state -- so the same film built twice produces impacts
    // that are deep-equal, and asking for a frame out of order changes nothing.
    const frames = hitFilm(24);
    const first = buildJuiceTrack(frames);
    const second = buildJuiceTrack(frames);

    for (let index = 0; index < first.frameCount; index += 1) {
      expect(first.at(index).impacts).toStrictEqual(second.at(index).impacts);
    }
    // Backwards, and out of order.
    for (const index of [first.frameCount - 1, 0, 5, 2, 11, 1]) {
      const target = Math.min(index, first.frameCount - 1);
      expect(second.at(target).impacts).toStrictEqual(first.at(target).impacts);
    }
  });

  it('gives a trade one impact per struck fighter, always in the same order', () => {
    const before = stateWith({ health: [100, 100] });
    const after = stateWith({ health: [91, 88], tick: 30 });
    const track = buildJuiceTrack(filmOf([[before, after], [after, after]]));

    const impacts = track.at(0).impacts;
    expect(impacts).toHaveLength(2);
    // Ordered by the event stream, which is ordered by agent index -- so the
    // drawn output is a function of the frame and not of bucketing order.
    expect(impacts[0].positionBasisPoints).toBe(track.events[0].positionBasisPoints);
    expect(impacts[1].positionBasisPoints).toBe(track.events[1].positionBasisPoints);
  });

  it('drops the impact under reduced motion and on the resting final frame', () => {
    // An additive full-brightness flash is a luminance change, which is exactly
    // what the preference is for; and one left frozen on the last frame forever
    // reads as a broken layout rather than as a finished Match.
    const still = buildJuiceTrack(hitFilm(24), DEFAULT_JUICE_TUNING, undefined, true);
    for (let index = 0; index < still.frameCount; index += 1) {
      expect(still.at(index).impacts).toStrictEqual([]);
    }

    const moving = buildJuiceTrack(hitFilm(24));
    expect(moving.at(moving.frameCount - 1).impacts).toStrictEqual([]);
    expect(countWhere(moving, (frame) => frame.impacts.length > 0)).toBeGreaterThan(0);
  });

  it('answers with an empty list rather than throwing on a degenerate film', () => {
    expect(buildJuiceTrack([]).at(0).impacts).toStrictEqual([]);
    expect(buildJuiceTrack([]).at(-1).impacts).toStrictEqual([]);
    expect(buildJuiceTrack(hitFilm(9)).at(9_999).impacts).toStrictEqual([]);
  });
});

describe('the tuning table and the art on disk cannot drift apart', () => {
  it('gives every kind an impactFrames equal to its pose frames x holdFrames', () => {
    // The cheapest possible guard against a retune silently desynchronising
    // from the sheet. The layout describes the *art* (how long a drawn cell
    // holds); the tuning describes the *effect* (how long the whole impact is
    // on screen). If they disagree the sprite either freezes on its last cell
    // or is cut off mid-pose -- and both look deliberate.
    //
    // Read from disk, not rebuilt here: a copy of the layout written into this
    // file would agree with itself forever while `public/fx/layout.json`
    // drifted.
    const layout = validateVfxSheetLayout(JSON.parse(readFileSync(SHIPPED_FX_LAYOUT, 'utf8')));

    for (const kind of ['hit', 'heavy', 'ko'] as const) {
      const pose = layout.poses[POSE_FOR_KIND[kind]];
      expect(DEFAULT_JUICE_TUNING.impactFrames[kind]).toBe(pose.frames * pose.holdFrames);
    }
  });

  it('pins the burst lifetimes to the same numbers, so a burst and its flash end together', () => {
    for (const kind of ['hit', 'heavy', 'ko'] as const) {
      expect(DEFAULT_JUICE_TUNING.sparks[kind].lifeFrames).toBe(
        DEFAULT_JUICE_TUNING.impactFrames[kind],
      );
    }
  });

  it('keeps every impact tuning integer, per-kind and frozen', () => {
    // Frames, never milliseconds (INV-1, INV-3), and a table a later story
    // retunes by editing a number rather than a call site.
    for (const table of [
      DEFAULT_JUICE_TUNING.impactFrames,
      DEFAULT_JUICE_TUNING.impactHeightPx,
      DEFAULT_JUICE_TUNING.impactSizePx,
      DEFAULT_JUICE_TUNING.impactFadeFrames,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(Object.keys(table).sort()).toStrictEqual(['heavy', 'hit', 'ko']);
      for (const value of Object.values(table)) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
    // The fade must fit inside the life it is ramping down over.
    for (const kind of ['hit', 'heavy', 'ko'] as const) {
      expect(DEFAULT_JUICE_TUNING.impactFadeFrames[kind]).toBeLessThan(
        DEFAULT_JUICE_TUNING.impactFrames[kind],
      );
    }
  });

  it('lets a retune lengthen only the impact without truncating it', () => {
    // The bucketing in `buildJuiceTrack` takes the longest of the shake, the
    // burst, the impact and the number. A version that bucketed on the burst
    // alone would silently cut an impact short the moment the two numbers
    // stopped being equal -- which is the exact edit this table invites.
    const longer: JuiceTuning = Object.freeze({
      ...DEFAULT_JUICE_TUNING,
      impactFrames: Object.freeze({ hit: 40, heavy: 40, ko: 40 }),
      impactFadeFrames: Object.freeze({ hit: 4, heavy: 4, ko: 4 }),
    });
    const track = buildJuiceTrack(
      filmOf([
        [stateWith({ health: [100, 100] }), stateWith({ health: [100, 91], tick: 30 })],
        [stateWith({ health: [100, 91], tick: 30 }), stateWith({ health: [100, 91], tick: 60 })],
        [stateWith({ health: [100, 91], tick: 60 }), stateWith({ health: [100, 91], tick: 90 })],
        [stateWith({ health: [100, 91], tick: 90 }), stateWith({ health: [100, 91], tick: 120 })],
      ]),
      longer,
    );
    expect(countWhere(track, (frame) => frame.impacts.length > 0)).toBe(40);
  });

  it('still opens a degenerate retune at full brightness', () => {
    // The assertion above -- `impactFadeFrames < impactFrames` -- reads
    // `DEFAULT_JUICE_TUNING` only, while `buildJuiceTrack` takes any exported
    // `JuiceTuning`. A fade as long as the whole life leaves no frame on which
    // `remaining > fadeFrames` holds, so without the clamp the sprite opens at
    // 11/12 alpha and never once draws at full: a pop at the *start*, in the
    // function whose two shipped defects were both pops.
    const degenerate: JuiceTuning = Object.freeze({
      ...DEFAULT_JUICE_TUNING,
      impactFadeFrames: Object.freeze({ hit: 12, heavy: 40, ko: 40 }),
    });
    const track = buildJuiceTrack(
      filmOf([
        [stateWith({ health: [100, 100] }), stateWith({ health: [100, 91], tick: 30 })],
        [stateWith({ health: [100, 91], tick: 30 }), stateWith({ health: [100, 91], tick: 60 })],
      ]),
      degenerate,
    );

    const alphas: number[] = [];
    for (let index = 0; index < track.frameCount; index += 1) {
      for (const impact of track.at(index).impacts) {
        alphas.push(impact.alphaBasisPoints);
      }
    }
    expect(alphas.length).toBeGreaterThan(0);
    // Full on the first frame, zero on the last, and monotonic in between --
    // the same shape the shipped tuning produces, one step steeper.
    expect(alphas[0]).toBe(BASIS_POINTS_FULL);
    expect(alphas[alphas.length - 1]).toBe(0);
    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeLessThanOrEqual(alphas[index - 1]);
    }
  });
});

/** How many clock frames satisfy a predicate. */
function countWhere(
  track: ReturnType<typeof buildJuiceTrack>,
  predicate: (frame: ReturnType<typeof track.at>) => boolean,
): number {
  let count = 0;
  for (let index = 0; index < track.frameCount; index += 1) {
    if (predicate(track.at(index))) {
      count += 1;
    }
  }
  return count;
}

/** The last clock index satisfying a predicate, or `-1`. */
function lastIndexWhere(
  track: ReturnType<typeof buildJuiceTrack>,
  predicate: (frame: ReturnType<typeof track.at>) => boolean,
): number {
  let found = -1;
  for (let index = 0; index < track.frameCount; index += 1) {
    if (predicate(track.at(index))) {
      found = index;
    }
  }
  return found;
}
