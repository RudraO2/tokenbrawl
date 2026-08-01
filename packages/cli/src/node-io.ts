import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import type { CliIo } from './io';

/**
 * The one file in this package that touches Node.
 *
 * Everything else takes a `CliIo`; only `cli.ts` constructs this. Keeping the
 * built-ins here is what makes the runner testable without a disk, and it is
 * also the boundary that keeps `process.env` from being reachable from any
 * module that might casually copy a key out of it.
 */

/**
 * A per-process suffix for the temporary file below.
 *
 * `process.pid` rather than a counter or a timestamp: two CLI processes
 * writing the same output directory (two providers, two terminals) must not
 * collide on one another's temporary file, and a clock reading would be a
 * wall-clock dependency in a repo that bans them on sight. INV-1 does not
 * reach this package -- the audit greps `packages/core` and `packages/env-*`
 * -- but a temp-file name is a poor place to start making exceptions, and the
 * pid is both stabler and more diagnosable when one is left behind.
 */
const TEMP_SUFFIX = `.tmp-${String(process.pid)}`;

export function createNodeIo(): CliIo {
  return {
    env: process.env,

    async readFile(path: string): Promise<string> {
      return await readFile(path, 'utf8');
    },

    /**
     * Write-then-rename, because `writeFile` is not atomic and a tournament
     * being killed halfway is this package's ordinary case, not its edge one.
     * `rename` within a directory is atomic on every platform this runs on, so
     * a reader sees either the previous file or the complete new one -- never
     * the half that had been flushed when the process died.
     */
    async writeFile(path: string, contents: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}${TEMP_SUFFIX}`;
      await writeFile(temporary, contents, 'utf8');
      await rename(temporary, path);
    },

    async listFiles(dir: string): Promise<readonly string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch {
        // An output directory that does not exist yet is the first run of a
        // tournament, which is not a failure. Every other read error would
        // also land here, and would then surface as "everything is
        // outstanding" -- which re-runs Matches but never skips one, the
        // correct direction to fail in.
        return [];
      }
    },

    async ensureDir(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true });
    },

    out(line: string): void {
      process.stdout.write(`${line}\n`);
    },

    err(line: string): void {
      process.stderr.write(`${line}\n`);
    },
  };
}
