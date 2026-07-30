import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vitest's default esbuild transform strips types and never type-checks.
 * That means nothing in the ordinary test run actually proves
 * `docs/contracts/index.ts` (or anything importing it via the
 * `@tokenbrawl/contracts` alias) type-checks under `strict: true`.
 *
 * This test spawns the real TypeScript compiler in `--noEmit` mode against
 * the whole project (every package + docs/contracts, per
 * `tsconfig.base.json`'s `include`) and asserts it exits 0. It genuinely
 * fails if a type error is introduced anywhere in that project — verified
 * manually during development by temporarily breaking a type, confirming
 * this test failed, then reverting.
 */
describe('contracts type-check', () => {
  it(
    'type-checks the whole project (incl. docs/contracts) under strict mode via tsc --noEmit',
    () => {
      const testFileDir = path.dirname(fileURLToPath(import.meta.url));
      const repoRoot = path.resolve(testFileDir, '..', '..', '..');
      const tsconfigPath = path.join(repoRoot, 'tsconfig.base.json');

      try {
        execSync(`npx tsc --noEmit -p "${tsconfigPath}"`, {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message: string };
        throw new Error(
          `tsc --noEmit failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`,
        );
      }

      // execSync throws on non-zero exit, so reaching here means exit 0.
      expect(true).toBe(true);
    },
    30_000,
  );
});
