import { readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateCommandLog } from '../../../../packages/core/src/command-log';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { validateReasoningSidecar } from '../replay/sidecar';
import { DEMO_SEED, buildDemoBundle, buildDemoLog } from './demo-log';
import { DEMO_SIDECAR_PATH } from './sidecar-split';

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
const REPLAYS = join(HERE, '..', '..', 'public', 'replays');
const DEMO_PATH = join(REPLAYS, 'demo.command-log.json');
const SIDECAR_PATH = join(REPLAYS, DEMO_SIDECAR_PATH);

/**
 * The hero replay is on the critical path of Story 4.2's 2-second budget, so
 * its size is an acceptance criterion rather than a curiosity. 32 KB is
 * generous for the current Match and tight enough that a log which quietly
 * regained its reasoning payload fails here rather than in a Lighthouse run
 * nobody re-ran.
 */
const HERO_REPLAY_BUDGET_BYTES = 32 * 1024;

function serialise(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

describe('the committed demo replay', () => {
  it('matches a freshly played Match, so the fixture cannot go stale', async () => {
    const bundle = await buildDemoBundle(DEMO_SEED);
    const rebuiltLog = serialise(bundle.log);
    const rebuiltSidecar = serialise(bundle.sidecar);

    if (process.env.TOKENBRAWL_WRITE_DEMO === '1') {
      mkdirSync(REPLAYS, { recursive: true });
      writeFileSync(DEMO_PATH, rebuiltLog, 'utf8');
      writeFileSync(SIDECAR_PATH, rebuiltSidecar, 'utf8');
    }

    const message =
      'The committed demo replay has drifted from the engine. Regenerate it with:\n' +
      '  TOKENBRAWL_WRITE_DEMO=1 npx vitest run --root apps/web src/testing/demo-log.test.ts';
    expect(readFileSync(DEMO_PATH, 'utf8'), message).toBe(rebuiltLog);
    expect(readFileSync(SIDECAR_PATH, 'utf8'), message).toBe(rebuiltSidecar);
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

  it('carries its reasoning in a sidecar, not in the document playback waits for (4.2 AC3)', () => {
    const log = validateCommandLog(JSON.parse(readFileSync(DEMO_PATH, 'utf8')));

    expect(log.reasoningSidecar).toBe(DEMO_SIDECAR_PATH);
    // Not "mostly": the field that grows without bound in a Deployment log must
    // be absent from every entry, or the split has only moved a copy.
    expect(log.decisions.every((entry) => entry.reasoning === undefined)).toBe(true);
    expect(log.decisions.every((entry) => entry.rawResponse === undefined)).toBe(true);

    const sidecar = validateReasoningSidecar(
      JSON.parse(readFileSync(SIDECAR_PATH, 'utf8')),
      log.matchId,
    );
    expect(sidecar.entries).toHaveLength(log.decisions.length);
    // Every Decision Point in the log is reachable in the sidecar by its own
    // identity. A split that dropped one would show a blank panel on hover.
    const keys = new Set(sidecar.entries.map((entry) => `${entry.tick}:${entry.agentIndex}`));
    for (const decision of log.decisions) {
      expect(keys.has(`${decision.tick}:${decision.agentIndex}`)).toBe(true);
    }
  });

  it('stays inside the hero-replay payload budget (4.2 AC1)', () => {
    expect(statSync(DEMO_PATH).size).toBeLessThan(HERO_REPLAY_BUDGET_BYTES);
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
