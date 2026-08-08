import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandLog } from '@tokenbrawl/contracts';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { PLAYBACK_FPS, buildReplayFilm } from '../replay/film';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack } from '../render/juice';
import { offsetForNow, validateSpectateManifest, type SpectateManifest } from './manifest';

/**
 * Story 11.6: the committed Spectate manifest, gated against drift.
 *
 * The same shape as `hero-artefact.test.ts`, for a sharper reason. Story 11.6
 * wired Spectate through the juice layer, which means every entry's clock now
 * runs the *track's* length -- the film plus every hitstop hold plus the
 * Ultimate's cinematic freeze, between +3% and +31% across these six pairings.
 * `manifest.json`'s `frameCount` is what `offsetForNow` walks to decide where a
 * visitor arriving right now joins the loop, so a recorded number on the wrong
 * axis is not a rounding error: it drifts the join by up to a third of a Match
 * and nothing on the page reports it. The failure is silent by construction,
 * which is exactly the kind that needs a test rather than a reviewer.
 *
 * Regenerate with:
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs apps/web/scripts/build-spectate-manifest.mts
 *
 * Paths come from `import.meta.url`, not `process.cwd()`, so this suite runs the
 * same from the repo root and from `apps/web`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLAYS = join(HERE, '..', '..', 'public', 'replays');

/**
 * The anchor the committed manifest carries.
 *
 * Written down here as well as in the build script on purpose: INV-3 says this
 * is a fixed constant chosen once, never `Date.now()` at generation time, and a
 * script quietly changed to stamp the current moment would still produce a
 * manifest that *looked* right. Two independent copies of the number is what
 * makes that edit fail a test instead of shipping.
 */
const LOOP_START_EPOCH_MS = 1_754_000_000_000;

function committedManifest(): SpectateManifest {
  return validateSpectateManifest(
    JSON.parse(readFileSync(join(REPLAYS, 'manifest.json'), 'utf8')),
  );
}

function clockFramesOf(commandLogUrl: string): { readonly frames: number; readonly hashOk: boolean } {
  const file = commandLogUrl.replace(/^\/replays\//, '');
  const log = JSON.parse(readFileSync(join(REPLAYS, file), 'utf8')) as CommandLog;
  const film = buildReplayFilm(log, createFighterEnvironment());
  const track = buildJuiceTrack(
    film.frames,
    DEFAULT_JUICE_TUNING,
    arenaFor(DEFAULT_FIGHTER_CONFIG),
    false,
    DEFAULT_FIGHTER_CONFIG,
  );
  return { frames: track.frameCount, hashOk: film.matchesRecordedHash };
}

describe('the committed Spectate manifest (Story 11.6)', () => {
  const manifest = committedManifest();
  const rebuilt = manifest.entries.map((entry) => ({
    id: entry.id,
    recorded: entry.frameCount,
    ...clockFramesOf(entry.commandLogUrl),
  }));

  it('records every entry`s clock frames, not its film frames', () => {
    expect(rebuilt.map((entry) => [entry.id, entry.recorded])).toStrictEqual(
      rebuilt.map((entry) => [entry.id, entry.frames]),
    );
  });

  it('records a count that is genuinely longer than the film, so the two axes cannot be confused', () => {
    // Without this, the case above would still pass on a manifest built from
    // film lengths if no Match in the stream happened to contain a hit.
    const films = manifest.entries.map((entry) => {
      const file = entry.commandLogUrl.replace(/^\/replays\//, '');
      const log = JSON.parse(readFileSync(join(REPLAYS, file), 'utf8')) as CommandLog;
      return buildReplayFilm(log, createFighterEnvironment()).frames.length;
    });
    for (const [index, entry] of rebuilt.entries()) {
      expect(entry.recorded).toBeGreaterThan(films[index]);
    }
  });

  it('every committed Command Log still verifies its own Final-State Hash (AD-15)', () => {
    expect(rebuilt.filter((entry) => !entry.hashOk)).toStrictEqual([]);
  });

  it('derives totalLoopDurationMs from those same counts at the playback rate', () => {
    const totalFrames = rebuilt.reduce((sum, entry) => sum + entry.frames, 0);
    expect(manifest.totalLoopDurationMs).toBe(Math.round((totalFrames / PLAYBACK_FPS) * 1000));
  });

  it('keeps loopStartEpochMs a fixed anchor rather than a generation-time timestamp (INV-3)', () => {
    expect(manifest.loopStartEpochMs).toBe(LOOP_START_EPOCH_MS);
  });

  it('lands a visitor where the loop actually is, frame for frame', () => {
    // The behavioural statement of the AC. Walking the concatenated entries for
    // the elapsed number of frames is what "where the loop actually is" means;
    // `offsetForNow` has to agree with that walk, and it only can when the
    // recorded counts are the same axis the clock runs on.
    const totalFrames = rebuilt.reduce((sum, entry) => sum + entry.frames, 0);
    /** The absolute frame the walk is on, flattened back across the concatenated entries. */
    const flatten = (offset: { readonly entryIndex: number; readonly frameOffset: number }): number =>
      rebuilt.slice(0, offset.entryIndex).reduce((sum, entry) => sum + entry.frames, 0) +
      offset.frameOffset;

    // Sampled across the whole loop and one lap beyond it. The tolerance is one
    // frame and one frame only: `offsetForNow` floors a ratio of floats, so a
    // sample that lands exactly on a frame boundary can land a millionth below
    // it. An axis error -- the bug this whole story is about -- is off by
    // hundreds of frames, not by one, so a ±1 window is wide enough to be
    // honest about the arithmetic and far too narrow to let the defect through.
    const samples = Array.from({ length: 40 }, (_, index) =>
      Math.floor((index * totalFrames * 2) / 40),
    );
    for (const elapsedFrames of samples) {
      const nowMs = manifest.loopStartEpochMs + (elapsedFrames / PLAYBACK_FPS) * 1000;
      expect(Math.abs(flatten(offsetForNow(manifest, nowMs)) - (elapsedFrames % totalFrames))).toBeLessThanOrEqual(1);
    }
  });

  it('never hands walk.ts an offset past the end of the entry it names', () => {
    // The clamp `walk.ts` applies is a belt; this is the braces. An offset equal
    // to an entry's own length would seek one frame past its last, which is the
    // shape the old film-length manifest produced on every entry with hitstop.
    const totalFrames = rebuilt.reduce((sum, entry) => sum + entry.frames, 0);
    for (const index of Array.from({ length: 200 }, (_, step) => step)) {
      const nowMs =
        manifest.loopStartEpochMs + ((index * totalFrames) / 200 / PLAYBACK_FPS) * 1000;
      const offset = offsetForNow(manifest, nowMs);
      expect(offset.frameOffset).toBeGreaterThanOrEqual(0);
      expect(offset.frameOffset).toBeLessThan(rebuilt[offset.entryIndex].frames);
    }
  });
});
