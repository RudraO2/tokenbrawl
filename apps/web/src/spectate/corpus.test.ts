import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateCommandLogV2 } from '../../../../packages/core/src/command-log-v2';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { validateSpectateManifest } from './manifest';

/**
 * Story 12.11: the Spectate corpus, gated on its content.
 *
 * The v1 corpus this replaced showed an Ultimate exactly once across seven logs,
 * held every fight to `schemaVersion 1.0.0`, and ended six of seven in timeout.
 * `scripts/audit-invariants.sh` pins the file-fact half of the fix (the v2 stamp,
 * an Ultimate in every entry, at least half ending in KO) with a grep; this file
 * is the deeper half a grep cannot reach, and the "checked twice" companion the
 * rest of this repo's discipline rules all have:
 *
 *   - every stream log validates against the frozen v2 schema (`Ajv`), and
 *   - every stream log replays to its own recorded Final-State Hash (the engine).
 *
 * Scope is the Spectate *stream* -- the logs the manifest walks. `demo.command-
 * log.json` is a separate v1 artefact with its own drift test (`testing/demo-
 * log.test.ts`) and is not part of the regenerated corpus; the player reads it
 * version-agnostically. See the story's Visual check finding for the reading.
 *
 * Paths come from `import.meta.url`, not `process.cwd()`, so this suite runs the
 * same from the repo root and from `apps/web`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLAYS = join(HERE, '..', '..', 'public', 'replays');

function committedManifest() {
  return validateSpectateManifest(JSON.parse(readFileSync(join(REPLAYS, 'manifest.json'), 'utf8')));
}

function readLog(commandLogUrl: string): ReturnType<typeof validateCommandLogV2> {
  const file = commandLogUrl.replace(/^\/replays\//, '');
  return validateCommandLogV2(JSON.parse(readFileSync(join(REPLAYS, file), 'utf8')));
}

describe('the committed Spectate corpus (Story 12.11)', () => {
  const manifest = committedManifest();
  const logs = manifest.entries.map((entry) => ({ id: entry.id, log: readLog(entry.commandLogUrl) }));

  it('is every one a schema-valid v2 Command Log', () => {
    // `readLog` already threw if any entry failed `validateCommandLogV2`; this
    // asserts the version stamp explicitly so a green run is unambiguous about
    // which schema was validated against.
    expect(logs.map((entry) => entry.log.schemaVersion)).toStrictEqual(
      logs.map(() => '2.0.0'),
    );
  });

  it('replays every log to its own recorded Final-State Hash (INV-2)', () => {
    const failures = logs.filter((entry) => {
      const film = buildReplayFilm(entry.log, createFighterEnvironment());
      return !film.matchesRecordedHash;
    });
    expect(failures.map((entry) => entry.id)).toStrictEqual([]);
  });

  it('carries at least one Ultimate in every entry', () => {
    const withoutUltimate = logs.filter(
      (entry) => !entry.log.decisions.some((decision) => decision.action === 'special'),
    );
    expect(withoutUltimate.map((entry) => entry.id)).toStrictEqual([]);
  });

  it('ends at least half of the stream in a KO rather than a timeout', () => {
    const ko = logs.filter((entry) => entry.log.result.endReason === 'ko').length;
    expect(ko * 2).toBeGreaterThanOrEqual(logs.length);
  });

  it('marks exactly one entry as the Ultimate showcase the visual gate selects', () => {
    const marked = manifest.entries.filter((entry) => entry.containsUltimate === true);
    expect(marked).toHaveLength(1);
    // The marked entry must itself contain an Ultimate, or the gate would drive
    // an entry that never draws the cinematic.
    const showcase = logs.find((entry) => entry.id === marked[0].id);
    expect(showcase?.log.decisions.some((decision) => decision.action === 'special')).toBe(true);
  });
});
