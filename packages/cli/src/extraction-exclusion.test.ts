import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Story 9.1 / AD-16: "any path outside the repository lives only in a
 * gitignored config, never a tracked file, never under `apps/web/public`, and
 * a test proves it mechanically."
 *
 * The professor's Extraction/NextGen reference project lives outside this
 * repo and is the only thing to render the visual pipeline against before the
 * four final AI-generated characters exist. `apps/web/src/dev/local-sprites.ts`
 * is the one place a path into it is allowed to be typed in -- a gitignored,
 * personal, dev-only config -- and this is the companion sweep to
 * `docs-discipline.test.ts` that makes sure that stays true: no tracked file
 * resolves a path outside the repository root, and nothing under
 * `apps/web/public` ever names the reference project.
 *
 * This file itself and `.gitignore` legitimately contain the literal strings
 * this test searches for (the .gitignore entry, and this file's own prose and
 * patterns), so both are excluded from the sweep the same way
 * `docs-discipline.test.ts` avoids scanning itself -- by reading known files
 * rather than walking the whole tree blind.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const THIS_FILE = 'packages/cli/src/extraction-exclusion.test.ts';
const GITIGNORE = '.gitignore';
const GITIGNORE_ENTRY = 'apps/web/sprites.local.json';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.woff2',
  '.woff',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.ogg',
  '.ico',
  '.pdf',
]);

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Normalise to forward slashes: `git ls-files` already uses `/`, but be
    // defensive in case this ever runs somewhere that doesn't.
    .map((line) => line.replace(/\\/g, '/'));
}

function isBinary(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function readTracked(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('.gitignore excludes the local sprites config (AC2)', () => {
  it('contains the entry', () => {
    const gitignore = readTracked(GITIGNORE);
    expect(gitignore).toContain(GITIGNORE_ENTRY);
  });
});

describe('apps/web/sprites.local.json is never tracked (AC2, AC5)', () => {
  it('does not appear in git ls-files', () => {
    const files = trackedFiles();
    expect(files).not.toContain(GITIGNORE_ENTRY);
  });
});

describe('no tracked source/config file resolves an out-of-root path (AC3)', () => {
  // Windows absolute path, e.g. C:\ or C:/. A negative lookbehind keeps this
  // from matching the tail of a URL scheme like "https:/" or "file:/", where
  // the letter before the colon is itself part of a longer word. A negative
  // lookahead excludes prose that names the *syntax* rather than a path --
  // e.g. a comment reading "a Windows `C:\...` path" -- which is not a
  // resolvable reference to anything.
  const WINDOWS_ABSOLUTE = /(?<![A-Za-z])[A-Za-z]:[\\/](?!\.\.\.)/;
  // POSIX absolute path outside a repo checkout.
  const POSIX_ABSOLUTE = /\/(?:Users|home)\//;
  // The literal segment "Extraction" adjacent to a path separator, e.g.
  // /Extraction/, \Extraction\, Desktop/Extraction.
  const EXTRACTION_SEGMENT = /[\\/]extraction(?=[\\/])|extraction[\\/]/i;

  it('finds no offending file', () => {
    const files = trackedFiles().filter((path) => {
      if (path === THIS_FILE || path === GITIGNORE) {
        return false;
      }
      // Prose docs legitimately name the mechanism, but only `.md` files are
      // prose -- `docs/contracts/index.ts` is source code imported by
      // `vite.config.ts` and stays in scope.
      if (path.endsWith('.md')) {
        return false;
      }
      if (isBinary(path)) {
        return false;
      }
      return true;
    });

    const offences: { file: string; match: string }[] = [];
    for (const file of files) {
      let contents: string;
      try {
        contents = readTracked(file);
      } catch {
        // Unreadable as text (e.g. some other binary format); not a
        // resolvable path reference either way.
        continue;
      }
      const windows = WINDOWS_ABSOLUTE.exec(contents);
      if (windows !== null) {
        offences.push({ file, match: windows[0] });
        continue;
      }
      const posix = POSIX_ABSOLUTE.exec(contents);
      if (posix !== null) {
        offences.push({ file, match: posix[0] });
        continue;
      }
      const extraction = EXTRACTION_SEGMENT.exec(contents);
      if (extraction !== null) {
        offences.push({ file, match: extraction[0] });
      }
    }

    expect(offences).toStrictEqual([]);
  });
});

describe('apps/web/public never references Extraction, by name or by path (AC4)', () => {
  it('finds no offending file', () => {
    const files = trackedFiles().filter((path) => path.startsWith('apps/web/public/'));
    expect(files.length).toBeGreaterThan(0);

    const offences: { file: string; match: string }[] = [];
    for (const file of files) {
      if (/extraction/i.test(file)) {
        offences.push({ file, match: 'filename' });
        continue;
      }
      if (isBinary(file)) {
        continue;
      }
      let contents: string;
      try {
        contents = readTracked(file);
      } catch {
        continue;
      }
      if (/extraction/i.test(contents)) {
        offences.push({ file, match: 'content' });
      }
    }

    expect(offences).toStrictEqual([]);
  });
});
