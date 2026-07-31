import { renderApp, type HostView, type MountPoint } from './main';
import { buildDemoLog } from './replay/demo-log';

/**
 * The page entry point, and the only file that touches a global.
 *
 * Split from `main.ts` so that module carries no top-level side effect and can
 * be imported by a test without mounting anything. Everything here is the
 * bootstrap: build a log, hand it to `renderApp`, and put a failure on the page
 * rather than in a console nobody opens.
 *
 * `document` and `window` are reached through `globalThis` rather than as bare
 * identifiers, the same way `packages/providers/src/http.ts` resolves `fetch`.
 * `tsconfig.base.json` has no DOM lib and must not gain one -- that would hand
 * `packages/core` ambient `document` and `window` types, weakening the
 * type-level half of INV-3 repo-wide -- so the globals are narrowed here
 * instead, at the one boundary that genuinely needs them.
 *
 * Until Story 4.6 lets a visitor supply their own, the log is a Match between
 * two Baseline Bots generated in the browser. That it works at all is AD-4
 * demonstrated end to end: the Harness and the Environment Adapter running
 * unmodified outside Node.
 */

interface BrowserGlobals {
  readonly document?: { querySelector(selectors: string): MountPoint | null };
  readonly window?: HostView;
}

async function boot(): Promise<void> {
  const globals = globalThis as unknown as BrowserGlobals;
  const root = globals.document?.querySelector('#app');
  const view = globals.window;

  if (root == null || view == null) {
    throw new Error('boot: this environment has no document or window to mount into.');
  }

  try {
    const log = await buildDemoLog();
    renderApp(root, log, view);
  } catch (error) {
    // A player that fails silently looks identical to one that is still
    // loading. Say what went wrong, on the page, in the house style.
    root.innerHTML = `
      <header class="tb-masthead"><h1 class="tb-wordmark">Tokenbrawl</h1></header>
      <div class="tb-readout">
        <span class="tb-chip tb-chip--failed">Replay failed</span>
        <span class="tb-chip tb-hash">${String(error instanceof Error ? error.message : error)}</span>
      </div>
    `;
  }
}

void boot();
