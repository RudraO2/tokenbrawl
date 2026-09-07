import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIO_TUNING } from './audio';
import { ROSTER_AUDIO, ROSTER_IDS } from './roster';

/**
 * Story 12.9: the cue names and the files behind them, checked against each
 * other rather than against a list.
 *
 * A cue name with no file is silent in exactly the way a missing cue is, and
 * nothing on screen says so -- which is the defect this whole story is built
 * around, and it is invisible to every other test in this directory because the
 * pure layer never fetches anything. So this file sweeps in both directions: a
 * name with no file fails, and a file no name asks for fails too. The second
 * direction matters as much as the first, because 290 KB shipped to a static
 * site with no CDN and nothing reading it is 290 KB nobody notices.
 *
 * Read off disk with `node:fs`, which is a test-only privilege here (the
 * shipped app is swept for Node built-ins by `source-discipline.test.ts`) and
 * the same one `renderer.test.ts` uses to pin the visual gate's literals.
 */

const PUBLIC_AUDIO = join(process.cwd(), 'public', 'audio');
const GATE = join(process.cwd(), '..', '..', 'scripts', 'visual-gate.mjs');

/** Every cue name the audio layer can emit: the shared tuning plus the roster table. */
function everyCueName(): readonly string[] {
  const shared = [
    DEFAULT_AUDIO_TUNING.music.name,
    ...Object.values(DEFAULT_AUDIO_TUNING.sfx),
    ...Object.values(DEFAULT_AUDIO_TUNING.voice),
    DEFAULT_AUDIO_TUNING.ultimate,
    DEFAULT_AUDIO_TUNING.ultimateVoice,
  ];
  const perCharacter = ROSTER_IDS.flatMap((id) => Object.values(ROSTER_AUDIO[id]));
  return [...new Set([...shared, ...perCharacter])].sort();
}

function committedCues(): readonly string[] {
  return readdirSync(PUBLIC_AUDIO)
    .filter((entry) => entry.endsWith('.mp3'))
    .map((entry) => entry.replace(/\.mp3$/, ''))
    .sort();
}

describe('every cue name has a file, and every file has a name (Story 12.9)', () => {
  it('resolves the whole cue set against the committed directory, both ways', () => {
    expect(committedCues()).toStrictEqual(everyCueName());
  });

  it('names one cue per fighter per event, for every fighter in the roster', () => {
    // The table is `Record<RosterId, …>`, so a missing fighter is a type error
    // -- but a fighter added to `ROSTER_IDS` and forgotten here is not, until
    // this runs.
    for (const id of ROSTER_IDS) {
      expect(Object.keys(ROSTER_AUDIO[id]).sort()).toStrictEqual([
        'heavy',
        'hit',
        'hurt',
        'ko',
      ]);
    }
    expect(ROSTER_IDS).toHaveLength(4);
    expect(everyCueName()).toHaveLength(23);
  });

  it('names each fighter after themselves, so a mis-keyed row is visible', () => {
    // A table wired to one fighter four times satisfies "every name resolves"
    // completely. This is the cheap half of catching that; the byte comparison
    // below is the half that cannot be fooled by a rename.
    for (const id of ROSTER_IDS) {
      for (const name of Object.values(ROSTER_AUDIO[id])) {
        expect(name).toContain(id);
      }
    }
  });
});

describe('no two fighters share a sample (Story 12.9)', () => {
  it('hashes every per-character file and finds sixteen distinct ones', () => {
    // The acceptance criterion, and it exists because the sizes look wrong: all
    // four `sfx_*_hit_l` are 4 747 B and all four `vo_*_ko` are 14 685 B, which
    // reads exactly like one file copied four times. Same encoder, same
    // duration, different audio -- and the next person to notice the collision
    // should find this test rather than have to check by hand.
    const digests = new Map<string, string>();
    for (const id of ROSTER_IDS) {
      for (const name of Object.values(ROSTER_AUDIO[id])) {
        digests.set(
          name,
          createHash('md5').update(readFileSync(join(PUBLIC_AUDIO, `${name}.mp3`))).digest('hex'),
        );
      }
    }
    expect(digests.size).toBe(16);
    expect(new Set(digests.values()).size).toBe(16);
  });

  it('compares the four fighters event by event, which is where a copy would land', () => {
    // Cross-fighter, per event. The sweep above would also fail on two *events*
    // of one fighter colliding, which is a different and less likely mistake;
    // this is the shape the criterion actually names.
    for (const event of ['hit', 'heavy', 'hurt', 'ko'] as const) {
      const digests = ROSTER_IDS.map((id) =>
        createHash('md5')
          .update(readFileSync(join(PUBLIC_AUDIO, `${ROSTER_AUDIO[id][event]}.mp3`)))
          .digest('hex'),
      );
      expect(new Set(digests).size).toBe(ROSTER_IDS.length);
    }
  });
});

describe('the audio payload stays inside the budget this story recorded (Story 12.9)', () => {
  /**
   * The budget, from the story file, in bytes.
   *
   * Written as the numbers the story wrote rather than as "whatever is on disk
   * plus a margin": a budget that is re-derived from the tree is not a budget.
   * The added figure is what the sixteen per-character files cost -- the four
   * `vo_*_transform` grunts were dropped when the Ultimate's announcement became
   * the stage's shared `vo_ultimate`, so they are no longer here to pay for. The
   * total is everything under `public/audio/`, which is on the critical path of
   * a static site with no CDN.
   */
  const ADDED_BUDGET_BYTES = 320 * 1024;
  const TOTAL_BUDGET_BYTES = 900 * 1024;

  /** What was here before Story 12.9 -- the seven shared cues, measured. */
  const SHARED_BYTES = 574_147;

  const bytesOf = (names: readonly string[]): number =>
    names.reduce((total, name) => total + statSync(join(PUBLIC_AUDIO, `${name}.mp3`)).size, 0);

  it('adds 141.1 KB of per-character audio against a 320 KB budget', () => {
    const added = bytesOf(ROSTER_IDS.flatMap((id) => Object.values(ROSTER_AUDIO[id])));
    expect(added).toBeLessThanOrEqual(ADDED_BUDGET_BYTES);
    expect(added).toBe(144_438);
  });

  it('keeps the whole directory under 900 KB', () => {
    const total = bytesOf(committedCues());
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET_BYTES);
    expect(total - 144_438).toBe(SHARED_BYTES);
  });
});

describe("the visual gate's cue list has not drifted (Story 12.9)", () => {
  it('matches the names the audio layer can actually emit', () => {
    // `scripts/visual-gate.mjs` is dependency-free ESM run straight by Node and
    // cannot import a `.ts` module, so `audio-cues-resolve` iterates its own
    // copy of the cue names -- the same standing arrangement `HUD_BAND` and
    // `STAGE_IDS` are under. This is the drift guard that makes the copy safe:
    // a cue added to the tuning or the roster table and forgotten in the gate
    // fails here, in the same change.
    const source = readFileSync(GATE, 'utf8');
    const literal = /const AUDIO_CUES = (\[[\s\S]*?\]);/.exec(source);
    expect(literal).not.toBeNull();
    const declared: unknown = JSON.parse((literal?.[1] ?? '[]').replace(/,(\s*])/, '$1'));
    expect([...(declared as string[])].sort()).toStrictEqual(everyCueName());
  });
});
