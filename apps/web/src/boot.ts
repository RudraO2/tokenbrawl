import { startup, type BrowserGlobals } from './startup';

/**
 * The page entry point, and nothing else.
 *
 * Story 4.1 kept the whole bootstrap here, which made it untestable: importing
 * this module runs it. Story 4.2 needs the bootstrap's *ordering* tested --
 * that the fight starts before any sprite, backdrop or sidecar is awaited -- so
 * the body moved to `startup.ts` and this file is reduced to the one line that
 * has a side effect. `startup.test.ts` drives that module with fakes; nothing
 * imports this one.
 */
void startup(globalThis as unknown as BrowserGlobals);
