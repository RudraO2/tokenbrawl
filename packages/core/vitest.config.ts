import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors the `@tokenbrawl/contracts` path alias in tsconfig.base.json for
// Vitest's runtime module resolution. Until this story, every import of
// `@tokenbrawl/contracts` across the repo was `import type` (erased before
// bundling, so it never needed real resolution). `testing/mock-environment.ts`
// is the first place that imports a *value* from contracts (`ACTIONS`) at
// runtime, which surfaced this gap.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tokenbrawl/contracts': path.resolve(here, '../../docs/contracts/index.ts'),
    },
  },
});
