import type { CommandLog } from '@tokenbrawl/contracts';
import { renderApp, type HostView, type MountPoint } from './main';

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
 * Until Story 4.6 lets a visitor supply their own, the log is a precomputed
 * Match between two Baseline Bots, fetched as a static file. It is *not* built
 * in the browser: `buildCommandLog` reaches `node:crypto` through
 * `canonical-hash.ts` and pulls in Ajv, so a page that generated its own log
 * died on load. Fetching is the architecture anyway (INV-8: precompute plus
 * static hosting) and is exactly how a real tournament log will arrive.
 *
 * What still runs in the browser is the whole simulation -- `replayCommandLog`,
 * the Environment Adapter and every frame of re-simulation. That is AD-4
 * demonstrated end to end.
 */

/** Same-origin, so it is covered by the no-remote-asset sweep in `style-discipline.test.ts`. */
const DEMO_REPLAY_URL = '/replays/demo.command-log.json';

interface BrowserGlobals {
  readonly document?: { querySelector(selectors: string): MountPoint | null };
  readonly window?: HostView;
  readonly fetch?: (url: string) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
}

async function boot(): Promise<void> {
  const globals = globalThis as unknown as BrowserGlobals;
  const root = globals.document?.querySelector('#app');
  const view = globals.window;

  if (root == null || view == null || globals.fetch == null) {
    throw new Error('boot: this environment has no document, window or fetch to mount into.');
  }

  try {
    const response = await globals.fetch(DEMO_REPLAY_URL);
    if (!response.ok) {
      throw new Error(
        `could not load ${DEMO_REPLAY_URL} (HTTP ${String(response.status)})`,
      );
    }
    // Cast, not validation: `buildReplayFilm` routes through
    // `replayCommandLog`, which checks the schema version before it reads any
    // other field and guards every field it then uses (AD-3). Running Ajv here
    // would drag the validator into the bundle for no additional safety.
    const log = (await response.json()) as CommandLog;
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
