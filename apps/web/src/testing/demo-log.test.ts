import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandLog } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { validateCommandLog } from '../../../../packages/core/src/command-log';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { DEMO_SEED, buildDemoLog } from './demo-log';

/**
 * The committed demo replay, and the guard that keeps it honest.
 *
 * `apps/web/public/replays/demo.command-log.json` is a precomputed static file
 * because `buildCommandLog` cannot run in a browser -- it reaches `node:crypto`
 * through `canonical-hash.ts` and pulls in Ajv besides. Precomputing is the
 * architecture anyway (INV-8: precompute plus static), and it means the page
 * loads a Command Log over HTTP exactly as it will load a real tournament log.
 *
 * But a recorded fixture goes stale the moment the frame data moves, and Story
 * 2.4's skill-separation gate exists precisely to keep moving it. So this file
 * rebuilds the Match from the same seed and fails if the committed JSON has
 * drifted. Regenerate with:
 *
 *   TOKENBRAWL_WRITE_DEMO=1 npx vitest run --root apps/web src/testing/demo-log.test.ts
 *
 * Generation lives here rather than in a standalone script because a bare
 * `node --experimental-strip-types` process cannot load `buildCommandLog` at
 * all: Ajv's `ajv/dist/2020` specifier is extensionless and unresolvable
 * outside a bundler. That is the same constraint `packages/core/src/replay.ts`
 * documents from the other side, and it is why the repo's existing
 * contracts-hooks are not enough here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_PATH = join(HERE, '..', '..', 'public', 'replays', 'demo.command-log.json');

function serialise(log: CommandLog): string {
  return `${JSON.stringify(log, null, 2)}\n`;
}

describe('the committed demo replay', () => {
  it('matches a freshly played Match, so the fixture cannot go stale', async () => {
    const rebuilt = serialise(await buildDemoLog(DEMO_SEED));

    if (process.env.TOKENBRAWL_WRITE_DEMO === '1') {
      mkdirSync(dirname(DEMO_PATH), { recursive: true });
      writeFileSync(DEMO_PATH, rebuilt, 'utf8');
    }

    const committed = readFileSync(DEMO_PATH, 'utf8');
    expect(
      committed,
      'The committed demo replay has drifted from the engine. Regenerate it with:\n' +
        '  TOKENBRAWL_WRITE_DEMO=1 npx vitest run --root apps/web src/testing/demo-log.test.ts',
    ).toBe(rebuilt);
  });

  it('is schema-valid and replays to its own recorded hash', () => {
    const log = validateCommandLog(JSON.parse(readFileSync(DEMO_PATH, 'utf8')));
    const film = buildReplayFilm(log, createFighterEnvironment());

    expect(log.environment.id).toBe('fighter-1v1');
    expect(log.seed).toBe(DEMO_SEED);
    expect(log.decisions.length).toBeGreaterThan(0);
    // The page opens on this file. If its hash did not verify, the player's own
    // AC5 chip would report a mismatch to every first-time visitor.
    expect(film.matchesRecordedHash).toBe(true);
    expect(film.divergences).toStrictEqual([]);
  });

  it('is deterministic in its seed, and different seeds give different Matches', async () => {
    const [a, b, other] = await Promise.all([
      buildDemoLog(DEMO_SEED),
      buildDemoLog(DEMO_SEED),
      buildDemoLog(9_999),
    ]);

    expect(a.finalStateHash).toBe(b.finalStateHash);
    expect(a.finalStateHash).not.toBe(other.finalStateHash);
  });
});
