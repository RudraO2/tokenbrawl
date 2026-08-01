import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors the `@tokenbrawl/contracts` path alias in tsconfig.base.json for
// Vitest's runtime module resolution, exactly as `packages/core` does. This
// package imports core's `match-runner`, which imports `FALLBACK_ACTION` --
// a *value* from contracts -- so the alias has to resolve at runtime, not
// just at type-check time.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tokenbrawl/contracts': path.resolve(here, '../../docs/contracts/index.ts'),
    },
  },
});
