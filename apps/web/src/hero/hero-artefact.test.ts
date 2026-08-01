import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandLog } from '@tokenbrawl/contracts';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import {
  HERO_AGENT_ID,
  HERO_OPPONENT_ID,
  HERO_TOKEN_BANK_START,
  buildHeroLog,
} from '../testing/hero-match';
import { renderHeroGif } from './hero';

/**
 * Story 7.4: the two committed hero artefacts, gated against drift.
 *
 * The same shape as `demo-log.test.ts`, for the same reason. A promotional
 * image at the top of a README is the one artefact nobody re-checks, and the
 * failure mode is specific: the frame data moves, the fight changes, and the
 * GIF keeps showing a Match this engine no longer plays. Rebuilding both here
 * makes that a red test rather than a quiet lie.
 *
 * Regenerate with:
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs apps/web/scripts/build-hero.mts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HERO_DIR = join(HERE, '..', '..', '..', '..', 'docs', 'hero');
const LOG_PATH = join(HERO_DIR, 'hero.command-log.json');
const GIF_PATH = join(HERO_DIR, 'hero.gif');

function committedLog(): CommandLog {
  return JSON.parse(readFileSync(LOG_PATH, 'utf8')) as CommandLog;
}

interface HeroEntry {
  readonly agentIndex: 0 | 1;
  readonly bankRemaining?: number;
  readonly reflexMode?: boolean;
  readonly reasoning?: string | null;
  readonly tokensSpent?: number | null;
}

function standInEntries(log: CommandLog): readonly HeroEntry[] {
  return (log.decisions as readonly HeroEntry[]).filter((entry) => entry.agentIndex === 0);
}

describe('the committed hero Command Log', () => {
  it('is exactly what the generator produces today', async () => {
    const rebuilt = `${JSON.stringify(await buildHeroLog(), null, 2)}\n`;
    expect(readFileSync(LOG_PATH, 'utf8')).toBe(rebuilt);
  });

  it('replays to the hash it records (INV-2)', () => {
    const film = buildReplayFilm(committedLog(), createFighterEnvironment());
    expect(film.divergences).toStrictEqual([]);
    expect(film.matchesRecordedHash).toBe(true);
  });

  it('is a Deployment against a Baseline Bot, and the Deployment is marked BYOK', () => {
    const log = committedLog();
    expect(log.agents[0]).toMatchObject({ id: HERO_AGENT_ID, kind: 'deployment' });
    expect(log.agents[1]).toMatchObject({ id: HERO_OPPONENT_ID, kind: 'bot' });
    // `byok` is the one provider value that is not a claim about a first-party
    // endpoint, and AD-11 bars a BYOK Match from every rating -- so this log
    // cannot reach a leaderboard even if it were dropped into the corpus.
    expect(log.agents[0].deployment?.provider).toBe('byok');
  });

  it('drains a Token Bank to zero and engages Reflex Mode (AC2)', () => {
    const entries = standInEntries(committedLog());
    const levels = entries
      .map((entry) => entry.bankRemaining)
      .filter((level): level is number => level !== undefined);

    expect(levels[0]).toBeLessThan(HERO_TOKEN_BANK_START);
    expect(levels).toContain(0);
    // Monotonically down: a bank that went back up would mean the debit was
    // being recomputed rather than carried.
    expect(levels.every((level, index) => index === 0 || level <= levels[index - 1])).toBe(true);
    expect(entries.some((entry) => entry.reflexMode === true)).toBe(true);
  });

  it('caps the Reflex-Mode calls at eight tokens, which is the mechanic being shown', () => {
    const reflex = standInEntries(committedLog()).filter((entry) => entry.reflexMode === true);
    expect(reflex.length).toBeGreaterThan(0);
    expect(reflex.every((entry) => entry.tokensSpent === 8)).toBe(true);
  });

  it('carries reasoning text on every polled Decision Point (AC2)', () => {
    const entries = standInEntries(committedLog());
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.every((entry) => (entry.reasoning ?? '').length > 0)).toBe(true);
  });

  it('records no bank field for the Baseline Bot, which consumes nothing', () => {
    const bot = (committedLog().decisions as readonly HeroEntry[]).filter(
      (entry) => entry.agentIndex === 1,
    );
    expect(bot.every((entry) => entry.bankRemaining === undefined)).toBe(true);
  });
});

describe('the committed hero GIF', () => {
  it('is exactly what the renderer produces from the committed log', () => {
    const rebuilt = renderHeroGif(committedLog());
    const committed = new Uint8Array(readFileSync(GIF_PATH));
    // Length first: a byte-for-byte diff of 180 KB is unreadable, and a size
    // mismatch is the failure a stale artefact actually produces.
    expect(committed.length).toBe(rebuilt.length);
    expect(committed).toStrictEqual(rebuilt);
  });

  it('is a GIF89a that loops forever, so GitHub plays it without a click (AC1)', () => {
    const bytes = readFileSync(GIF_PATH);
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(bytes.includes(Buffer.from('NETSCAPE2.0', 'latin1'))).toBe(true);
  });

  it('stays small enough to load at the top of a README', () => {
    // GitHub serves a README image through its own proxy and a multi-megabyte
    // hero is one nobody on a phone ever sees animate.
    expect(readFileSync(GIF_PATH).length).toBeLessThan(2_000_000);
  });
});
