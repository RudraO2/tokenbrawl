import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors the `@tokenbrawl/contracts` path alias in tsconfig.base.json for
// Vitest's runtime module resolution, exactly as packages/core does. Needed
// from Story 2.1 on because `src/environment.ts` is this package's first
// import of a *value* (`ACTIONS`) from contracts rather than a type.
//
// This file is build tooling, not shipped simulation code: it runs only under
// Vitest in Node, never in a browser, so the `node:` imports here are outside
// AD-4's scope (the audit script and `source-discipline.test.ts` both scope
// their Node-built-in ban to `src/`).
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tokenbrawl/contracts': path.resolve(here, '../../docs/contracts/index.ts'),
    },
  },
});
