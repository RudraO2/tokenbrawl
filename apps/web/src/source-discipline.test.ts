import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Story 4.1, AC3: "given the player source, when inspected, then it reads no
 * wall-clock or latency field".
 *
 * That is a claim about what is *absent*, and a behavioural test cannot prove
 * an absence. A sweep can. This file is the machine half of INV-3 for
 * `apps/web`, in the same shape as `packages/env-fighter`'s and
 * `packages/providers`' own discipline sweeps.
 *
 * It matters more here than anywhere else in the repo. Every other package is
 * covered by `scripts/audit-invariants.sh`, whose INV-1 and INV-3 greps run
 * over `packages/core` and `packages/env-*` only -- `apps/web` is outside that
 * sweep entirely, and it is the one place where writing a delta-time animation
 * loop would be the *obvious* thing to do.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

function walk(directory: string, collected: SourceFile[]): SourceFile[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // `src/testing/` is Node-only tooling that never reaches the bundle --
      // `demo-log.ts` deliberately imports `buildCommandLog`, which is exactly
      // what the checks below forbid a shipped file to do.
      if (entry.name === 'testing') {
        continue;
      }
      walk(full, collected);
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      collected.push({ path: relative(SRC, full), source: readFileSync(full, 'utf8') });
    }
  }
  return collected;
}

/** Every file that actually reaches the browser bundle. Tests and `src/testing/` are exempt. */
function shippedFiles(): readonly SourceFile[] {
  return walk(SRC, []);
}

/** Lines that are wholly a comment. Prose may legitimately name a banned token — this file's own docblock does. */
function codeLines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*')
      );
    });
}

function offendingLines(pattern: RegExp): readonly string[] {
  const offences: string[] = [];
  for (const { path, source } of shippedFiles()) {
    for (const { line, text } of codeLines(source)) {
      if (pattern.test(text)) {
        offences.push(`${path}:${line}: ${text.trim()}`);
      }
    }
  }
  return offences;
}

describe('shipped player source discipline', () => {
  it('finds the files it is meant to police', () => {
    const paths = shippedFiles().map((file) => file.path.replace(/\\/g, '/'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'main.ts',
        'boot.ts',
        'startup.ts',
        'replay/film.ts',
        'replay/sidecar.ts',
        'render/renderer.ts',
        'player/clock.ts',
      ]),
    );
    expect(paths.every((path) => !path.endsWith('.test.ts'))).toBe(true);
  });

  it('reads no wall-clock anywhere (AC3, INV-3)', () => {
    // Playback advances by counting callbacks. There is no legitimate reason
    // for any of these to appear on the render path, and each of them is a
    // one-line edit away from making a Match's playback depend on how long a
    // Deployment took to think.
    const wallClock =
      /\b(Date\.now|performance\.now|new Date\(|Date\.parse|process\.hrtime|setInterval)\b/;
    expect(offendingLines(wallClock)).toStrictEqual([]);
  });

  it('reads no latency, duration or elapsed field (AC3)', () => {
    // The Command Log schema exposes none of these, so a reference to one is
    // either dead code or the first half of a change that would need the
    // frozen contract widened.
    const timingField = /\b(latency|latencyMs|elapsed|elapsedMs|durationMs|thinkTime|responseTime|timestamp)\b/;
    expect(offendingLines(timingField)).toStrictEqual([]);
  });

  it('never paces playback on a delta between two clock readings', () => {
    // `deltaTime`/`dt` is how every ordinary animation loop is written, and it
    // is precisely the shape INV-3 forbids: playback would then depend on the
    // viewer's refresh rate and on how long the tab was backgrounded.
    expect(offendingLines(/\b(deltaTime|deltaMs|dt)\b/)).toStrictEqual([]);
  });

  it('declares no module-level mutable binding, which is where cross-frame state hides', () => {
    const offences: string[] = [];
    for (const { path, source } of shippedFiles()) {
      for (const { line, text } of codeLines(source)) {
        if (/^(let|var)\s/.test(text)) {
          offences.push(`${path}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('imports nothing bare except the frozen contracts', () => {
    // The player reaches core and env-fighter by relative path, which is the
    // house convention until the `main`/`exports` gap is closed. AD-4 permits
    // this one consumer-to-adapter dependency: replay *is* re-simulation, so
    // the player must import the Environment Adapter.
    //
    // Scanned over code lines rather than raw source. The raw-source version
    // read `distinct both from "this Agent recorded no reasoning" and from
    // "the reasoning could not be fetched"` in a doc comment as two bare
    // imports -- English uses the word `from` in front of a quoted string as
    // readily as TypeScript does. Every other check in this file already drops
    // comment lines first, for the same reason.
    const bare: string[] = [];
    for (const { path, source } of shippedFiles()) {
      for (const { text } of codeLines(source)) {
        for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
          if (!match[1].startsWith('.')) {
            bare.push(`${path}: ${match[1]}`);
          }
        }
      }
    }
    expect([...new Set(bare.map((entry) => entry.split(': ')[1]))]).toStrictEqual([
      '@tokenbrawl/contracts',
    ]);
  });

  it('imports nothing from core that cannot run in a browser', () => {
    // A real defect this story hit, found by opening the page rather than by
    // any test: `command-log.ts` imports `canonical-hash.ts`, which imports
    // `node:crypto`, and it pulls in Ajv besides. Vite externalises
    // `node:crypto`, so the page died on load with "Module node:crypto has
    // been externalized for browser compatibility" -- a blank screen, and
    // every unit test still green, because none of them run in a browser.
    //
    // `packages/core/src/replay.ts` documents the same constraint from the
    // other side: it stays dependency-starved so a bare Node child can load
    // it. It turns out to bind the browser exactly as hard. AD-4 says an
    // Environment Adapter must run in Node and in a browser alike, and
    // `audit-invariants.sh` enforces that for `packages/env-*` only -- this is
    // the same rule for the consumer that AD-4 permits to import one.
    const browserHostile = /from\s+['"][^'"]*\/(command-log|canonical-hash)['"]/;
    expect(offendingLines(browserHostile)).toStrictEqual([]);
  });

  it('imports no Node built-in and no Node global (AD-4, for the consumer)', () => {
    const builtin =
      /from\s+['"]node:[a-z_/]+['"]|from\s+['"](fs|path|crypto|os|util|stream|child_process)['"]/;
    expect(offendingLines(builtin)).toStrictEqual([]);

    // Globals need no import and break a bundle just as hard. `globalThis` is
    // the sanctioned way to reach a host object (see `boot.ts`), so a bare
    // `process.`/`Buffer.` is what is banned.
    expect(offendingLines(/(^|[^A-Za-z0-9_$.])(process|Buffer|__dirname|__filename)\s*[.(]/)).toStrictEqual(
      [],
    );
  });

  it('adds no runtime dependency to the app', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toStrictEqual(['vite', 'vitest']);
  });
});
