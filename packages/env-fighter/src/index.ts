import type { Action } from '@tokenbrawl/contracts';

/**
 * Placeholder export for Story 1.1 (scaffold only). The deterministic
 * fighter environment lands in a later Epic-2 story.
 *
 * This package must never import a Node built-in (no `fs`, `path`, or
 * `node:*`) — per AD-4 it has to run unmodified in both Node and a browser
 * bundler.
 */
export const placeholder = true;

/** Proves the `@tokenbrawl/contracts` alias resolves here too. Type-only. */
export type PlaceholderAction = Action;
