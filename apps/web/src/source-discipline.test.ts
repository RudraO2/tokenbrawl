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
      walk(full, collected);
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      collected.push({ path: relative(SRC, full), source: readFileSync(full, 'utf8') });
    }
  }
  return collected;
}

/** Every shipped TypeScript file in the app. Test files are exempt: this one reads `node:fs` to do its job. */
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
        'replay/film.ts',
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
    const bare: string[] = [];
    for (const { path, source } of shippedFiles()) {
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('.')) {
          bare.push(`${path}: ${match[1]}`);
        }
      }
    }
    expect([...new Set(bare.map((entry) => entry.split(': ')[1]))]).toStrictEqual([
      '@tokenbrawl/contracts',
    ]);
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
