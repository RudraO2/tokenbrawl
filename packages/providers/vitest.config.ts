import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors the `@tokenbrawl/contracts` path alias in tsconfig.base.json for
// Vitest's runtime module resolution, exactly as packages/core does. Story 3.2
// is the first place in this package whose tests reach into
// `packages/core/src/*` -- and core's `action-grammar.ts` imports `ACTIONS` as
// a *value*, so the alias has to resolve at runtime here too.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tokenbrawl/contracts': path.resolve(here, '../../docs/contracts/index.ts'),
    },
  },
});
