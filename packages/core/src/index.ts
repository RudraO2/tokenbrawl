import type { Action } from '@tokenbrawl/contracts';

/**
 * Placeholder export for Story 1.1 (scaffold only). The real Harness lands
 * in later Epic-1 stories; this package intentionally contains no game
 * logic, no Agent, and no provider adapter yet.
 */
export const placeholder = true;

/**
 * Proves the `@tokenbrawl/contracts` path alias resolves to the frozen
 * `docs/contracts/index.ts` under strict mode. Type-only, so it is erased at
 * runtime and never needs module resolution outside of `tsc`.
 */
export type PlaceholderAction = Action;
