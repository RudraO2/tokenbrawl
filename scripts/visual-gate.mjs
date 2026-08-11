#!/usr/bin/env node
// The visual exit gate. Story 12-1.
//
// `npm test` asserts canvas *call sequences*; `audit-invariants.sh` greps
// source. Neither can see a screen, and that is not a small gap -- it is the
// reason forty stories passed every gate while the product shipped a
// Play-vs-CPU mode with no canvas at all, a page that scrolls sideways on a
// phone, and a Spectate stream that once held a single still frame.
// `docs/VISUAL-CHECK.md` described the right checks in prose, and prose is a
// suggestion. This file is the gate.
//
// ## Why there are no dependencies
//
// The repo's rule is that `apps/web` carries vite and vitest and nothing else,
// and while `scripts/` is not bound by it, a headless-browser dependency is a
// 300 MB install and a second thing that can rot. Node 22 ships a global
// `WebSocket`, and Chrome speaks the DevTools Protocol over one, so the whole
// driver below is about 120 lines and depends on the Chrome the developer
// already has. `CHROME_PATH` overrides the search if theirs is somewhere else.
//
// ## The ratchet, and why a failing check does not deadlock the loop
//
// Several checks here fail *today* -- that is the point of writing them. If a
// failing check simply failed the gate, no story could ever be committed and
// `bmad-loop` would deadlock on the first one. So failures named in
// `docs/visual/known-failures.json` are reported and tolerated, each one
// carrying the story key that owes the fix.
//
// The ratchet only turns one way. A waived check that starts *passing* fails
// the gate, with a message telling you to delete its waiver. Without that, a
// waiver outlives the defect it described and the file quietly becomes a list
// of checks nobody runs.
//
// Usage:
//   node scripts/visual-gate.mjs [--label <name>] [--keep-open]
//
// Exit 0: every unwaived check passed and every waiver is still earned.
// Exit 1: an unwaived check failed, or a waived check passed, or the harness
//         could not get far enough to judge (a browser that will not start is
//         a gate failure, never a silent pass).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web');
const VITE_BIN = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const WAIVERS_PATH = join(REPO_ROOT, 'docs', 'visual', 'known-failures.json');

/**
 * Desktop first, then a phone. Both are captured every run.
 *
 * 390x844 is an iPhone 14; it is here because the horizontal-overflow defect
 * only appears below the 960px the arena canvas is drawn at, and no story ever
 * looked at the page narrow enough to see it.
 */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

/**
 * The three surfaces, by host element. Straight from `docs/VISUAL-CHECK.md`:
 * every one is captured every run even when a story names only one of them,
 * because the Spectate regression survived precisely by not being mentioned.
 *
 * Story 12.4 gave each one a `route`. The page is a cabinet now -- exactly one
 * screen shows -- so a capture has to *navigate* before it scrolls, and a gate
 * that stopped reaching a surface would have hidden the next Spectate
 * regression rather than fixed a layout.
 */
const SURFACES = [
  { id: 'app', selector: '#app', route: '/replay', label: 'replay player' },
  { id: 'arcade', selector: '#arcade', route: '/play', label: 'play vs cpu' },
  { id: 'spectate', selector: '#spectate', route: '/watch', label: 'spectate stream' },
  // Story 12.5. Not a rendering surface -- it holds no canvas -- but it is a
  // screen a visitor spends time on, and the story that built it could not be
  // judged from its own captures without one: `character-select-reachable`
  // matches *text*, which is exactly the evidence two unreachable fighters
  // already had for three epics. A portrait that decodes and lays out at zero
  // height would pass every check in this file and show nothing.
  { id: 'select', selector: '#select', route: '/select', label: 'character select' },
];

/**
 * Every screen, in nav order. Mirrors `apps/web/src/shell/screens.ts`.
 *
 * Duplicated rather than imported: this script is dependency-free ESM run
 * straight by Node, and importing a `.ts` module from the app would need a
 * loader. The registry test in `shell/router.test.ts` pins the same list from
 * the other side, so a screen added there and forgotten here shows up as a
 * `one-screen-at-a-time` reading that does not mention it.
 */
const SCREEN_ROUTES = ['/', '/play', '/select', '/watch', '/replay', '/byok'];

/** The screens that hold an arena canvas, and therefore the ones the framing checks sample. */
const ARENA_ROUTES = ['/replay', '/play', '/watch'];

/**
 * Every stage, in list order. Mirrors `apps/web/src/render/stages.ts` (Story
 * 12.10).
 *
 * Duplicated for this file's standing reason -- dependency-free ESM run straight
 * by Node cannot import a `.ts` module -- the same as `SCREEN_ROUTES` and
 * `HUD_BAND`. `stages.test.ts` reads this literal off disk and pins it to
 * `STAGE_IDS`, so a stage added there and forgotten here fails the suite; and
 * `every-stage-draws` below compares this list's length against the number of
 * `[data-select-stage]` cards the page renders, so a stage wired on one side and
 * not the other shows up as a drift reading rather than an unchecked stage.
 */
const STAGE_IDS = ['stage-1', 'stage-2', 'stage-3', 'stage-4', 'stage-5', 'stage-6'];

/**
 * Console lines that are environmental rather than defects.
 *
 * Deliberately a short, commented allowlist rather than a severity filter: the
 * asset loaders in `startup.ts` warn instead of throwing, so a pack that failed
 * to decode reports itself *only* here. A broad filter would throw that away.
 */
const CONSOLE_ALLOWLIST = [
  // Dev-server HMR chatter.
  '[vite]',
  // The gate's own doing. `CANVAS_PROBE` calls `getImageData` on a context
  // created for drawing, and Chrome suggests `willReadFrequently`. Blaming the
  // app for a warning the measurement caused would be the check reporting on
  // itself.
  'willReadFrequently',
  // A browser policy notice, not a defect. Chrome emits this for any page that
  // builds an AudioContext before a user gesture, which is the correct thing
  // for `audio-bus.ts` to do -- the graph is constructed early and resumed on
  // the first interaction. Story 12-9 owns making that resume automatic on the
  // first gesture; it does not own silencing a notice Chrome prints either way.
  'The AudioContext was not allowed to start',
];

/** How long a canvas is watched before it is called static. Two playback frames is not enough. */
const ANIMATION_SAMPLE_MS = 700;

/** Ink threshold below which a canvas counts as blank. 2% is far under any real frame. */
const MIN_INK_RATIO = 0.02;

// --------------------------------------------------------------------------
// tiny CDP client
// --------------------------------------------------------------------------

/**
 * A DevTools Protocol connection to the browser, with one attached page session.
 *
 * Browser-scoped rather than page-scoped, which is the less obvious of the two
 * choices and the one that works. Dialling the page socket from `/json/list`
 * looks simpler and connects fine, but under `--headless=new` the first method
 * that touches the page comes back `Not attached to an active page (-32000)`.
 * So the gate connects to the browser, creates its own target, attaches with
 * `flatten: true`, and threads the resulting `sessionId` through every message.
 */
class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  /** Set by `attachToNewPage`; every subsequent message carries it. */
  sessionId;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.#pending.get(message.id);
        if (entry === undefined) return;
        this.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message} (${message.error.code})`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`Could not open a DevTools socket at ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    const message = { id, method, params };
    // Browser-domain calls (`Target.*`) must go unsessioned; everything else is
    // addressed at the attached page.
    if (this.sessionId !== undefined && !method.startsWith('Target.')) {
      message.sessionId = this.sessionId;
    }
    return new Promise((resolve_, reject) => {
      this.#pending.set(id, { resolve: resolve_, reject, method });
      this.#ws.send(JSON.stringify(message));
    });
  }

  /** Opens a fresh page target and binds this connection's session to it. */
  async attachToNewPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
  }

  on(method, listener) {
    const existing = this.#listeners.get(method) ?? [];
    existing.push(listener);
    this.#listeners.set(method, existing);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // A socket that is already gone is the state we wanted.
    }
  }

  /**
   * Evaluates an expression in the page and returns its value.
   *
   * Throws on a page-side exception rather than returning `undefined`: a check
   * whose probe silently failed would report a pass it never measured.
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Page evaluation failed: ${text}`);
    }
    return result.result.value;
  }
}

// --------------------------------------------------------------------------
// process plumbing
// --------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitForHttp(url, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
    } catch {
      // Not up yet. The deadline is the only thing that ends this loop.
    }
    await sleep(150);
  }
  throw new Error(`${what} did not come up at ${url} within ${timeoutMs}ms`);
}

/**
 * Kills a child and, on Windows, its whole tree.
 *
 * Chrome spawns helper processes that outlive a bare `kill` of the launcher,
 * and a leaked headless Chrome holds the temp profile directory open, which
 * makes the *next* run fail on cleanup rather than this one.
 */
function killTree(child) {
  if (child === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

/** Where Chrome sits under each Windows install root. */
const CHROME_UNDER_ROOT = 'Google/Chrome/Application/chrome.exe';

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  // The Windows roots are read from the environment rather than written as
  // drive-letter literals. Two reasons, and the second is the one that bites:
  // a machine with Chrome on another drive or a localised "Program Files" is
  // found this way and was not before -- and a tracked source file containing an
  // absolute path fails Story 9.1's out-of-root exclusion test
  // (`packages/cli/src/extraction-exclusion.test.ts`), which this script tripped
  // from the moment Story 12-1 added it.
  const windowsRoots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter((root) => typeof root === 'string' && root.length > 0);
  const candidates = [
    ...windowsRoots.map((root) => join(root, CHROME_UNDER_ROOT)),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (found === undefined) {
    throw new Error('No Chrome found. Set CHROME_PATH to the browser binary.');
  }
  return found;
}

// --------------------------------------------------------------------------
// in-page probes
//
// Every probe below is a single expression string. They live here rather than
// in a fixture file so a reader can see, in one place, exactly what the gate
// measures -- a check whose measurement is somewhere else is a check nobody
// audits.
// --------------------------------------------------------------------------

/**
 * Per-canvas geometry, ink coverage and a cheap content hash.
 *
 * `getImageData` rather than a screenshot diff: the canvas is same-origin so it
 * is never tainted, the pixels come back without decoding a PNG, and the ink
 * ratio it yields is what separates "a frame was drawn" from "a valid sequence
 * of calls was made against a canvas nobody attached".
 */
const CANVAS_PROBE = `(() => {
  return [...document.querySelectorAll('canvas')].map((c) => {
    const rect = c.getBoundingClientRect();
    let ink = 0, sampled = 0, hash = 0;
    let readable = false;
    try {
      const ctx = c.getContext('2d');
      if (ctx) {
        readable = true;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < data.length; i += 28) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          sampled++;
          if (a > 8 && r + g + b > 36) ink++;
          hash = (hash * 31 + r + g * 3 + b * 7) | 0;
        }
      }
    } catch (error) {
      readable = false;
    }
    const host = c.closest('#app, #arcade, #spectate');
    return {
      host: host ? host.id : null,
      className: c.className,
      backbuffer: c.width + 'x' + c.height,
      boxWidth: Math.round(rect.width),
      boxHeight: Math.round(rect.height),
      visible: rect.width > 0 && rect.height > 0,
      readable,
      inkRatio: sampled ? ink / sampled : 0,
      hash,
    };
  });
})()`;

const OVERFLOW_PROBE = `(() => {
  const root = document.documentElement;
  const widest = [...document.querySelectorAll('body *')]
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || ''), right: Math.round(el.getBoundingClientRect().right) }))
    .filter((entry) => entry.right > root.clientWidth + 1)
    .sort((a, b) => b.right - a.right)
    .slice(0, 3);
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders: widest };
})()`;

/** Clicks the first button under `host` whose visible text matches `pattern`. */
const clickIn = (hostSelector, pattern) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return { ok: false, why: 'host missing' };
  const button = [...host.querySelectorAll('button')]
    .find((b) => new RegExp(${JSON.stringify(pattern)}, 'i').test(b.textContent.trim()));
  if (!button) return { ok: false, why: 'button missing', seen: [...host.querySelectorAll('button')].map((b) => b.textContent.trim()) };
  button.click();
  return { ok: true, clicked: button.textContent.trim() };
})()`;

const hostCanvasProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return { hostPresent: false, canvases: 0, visible: 0 };
  const canvases = [...host.querySelectorAll('canvas')];
  const visible = canvases.filter((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return { hostPresent: true, canvases: canvases.length, visible: visible.length };
})()`;

/**
 * Which screen sections have a non-zero bounding box (Story 12.4).
 *
 * The check is "exactly one", and it is deliberately measured off the *box*
 * rather than off the attribute the router moves. An attribute sweep would pass
 * on a stylesheet that never shipped the `display` rule, which is the one way
 * this feature can be wired correctly in TypeScript and be completely absent to
 * a visitor -- the failure mode this repo keeps shipping.
 */
const SCREEN_BOXES_PROBE = `(() => {
  return [...document.querySelectorAll('[data-screen]')].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.id,
      active: el.hasAttribute('data-screen-active'),
      area: Math.round(rect.width) * Math.round(rect.height),
    };
  });
})()`;

/**
 * Whether a screen offering four fighters is reachable (Story 12.4, owed by 12.5).
 *
 * Reads the *shown* screen, so it cannot be satisfied by a roster sitting in a
 * hidden section: reachable means a visitor got there. Four names rather than a
 * count of buttons, because "four things to click" is satisfied by four copies
 * of the same fighter.
 */
const CHARACTER_SELECT_PROBE = `(() => {
  const shown = [...document.querySelectorAll('[data-screen]')]
    .find((el) => el.getBoundingClientRect().height > 0);
  if (!shown) return { reached: false, found: [] };
  const text = (shown.textContent || '').toLowerCase();
  const roster = ['clawde', 'chatty', 'gemini', 'grokk'];
  return { reached: true, screen: shown.id, found: roster.filter((name) => text.includes(name)) };
})()`;

/**
 * Clicks the character-select card for `id` on `side` (Story 12.5).
 *
 * By the card's own `data-select-pick` attribute rather than by its visible
 * text, because the plate and the id differ in case and a text match would go
 * green on the *opponent's* card just as happily as the visitor's.
 */
const pickFighter = (side, id) => `(() => {
  const card = document.querySelector('[data-select-pick="' + ${JSON.stringify(String(side))} + ':' + ${JSON.stringify(id)} + '"]');
  if (!card) return { ok: false, why: 'no card for ' + ${JSON.stringify(id)} };
  card.click();
  return { ok: true, pressed: card.getAttribute('aria-pressed') };
})()`;

/**
 * Scrolls a surface's *canvas* to the middle of the viewport, or the surface
 * itself when it has none.
 *
 * `scrollIntoView(selector)` centres the whole section, and on a 390px phone a
 * section taller than the viewport centres on whatever happens to be in its
 * middle -- which on `#app` is the reasoning panel. Story 12.3's finding had to
 * record that its mobile replay capture showed no arena at all, and the run was
 * green because the framing was measured separately. A capture that does not
 * show the thing it is named after is not evidence.
 */
const scrollSurfaceIntoView = (selector) => `(() => {
  const host = document.querySelector(${JSON.stringify(selector)});
  if (!host) return false;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  (canvas ?? host).scrollIntoView({ block: 'center' });
  return true;
})()`;

const scrollIntoView = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  return true;
})()`;

/**
 * Dispatches a real `keydown` on `selector`. Story 12.2's
 * `arcade-input-moves-fighter` drives the fighter this way -- an actual
 * `KeyboardEvent` on the page's key-capture element -- rather than by calling
 * into the panel, so the check exercises the same path a visitor's keyboard
 * does, listener and all.
 */
const dispatchKeydown = (selector, key) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
  return true;
})()`;

/**
 * Height of the HUD band at the top of the arena, in backbuffer pixels.
 *
 * `renderer.ts`'s `HUD_BOTTOM` is 144 since Story 12.6 gave the armed callout
 * and the `HP … MTR …` readout rows of their own; 152 leaves margin under it.
 * The fighter-movement check below hashes *below* this line and nothing above it,
 * which is the difference between a check that measures the fight and one that
 * measures the clock: `TICK NNN` and the health/meter bars change every Decision
 * Point on their own, so a whole-canvas hash goes green on a canvas whose
 * fighters are frozen, drawn as blocks, or drawn off-stage. Excluding the band
 * makes the check fail if the *fighters* stop moving, which is what it is for.
 */
const ARENA_TOP_PX = 152;

/**
 * The HUD band, copied from `apps/web/src/render/renderer.ts` (Story 12.6).
 *
 * Duplicated for this file's standing reason -- it is dependency-free ESM run
 * straight by Node and cannot import a `.ts` module, the same reason
 * `SCREEN_ROUTES` and `ARENA_TOP_PX` are copies. What makes the copy safe is
 * that `renderer.test.ts` reads *this literal* off disk and compares it against
 * `HUD_ROW_SPANS` and `hudRegions(960 x 400)`, so a layout edit that moved a bar
 * and left the gate sampling empty rows fails the suite in the same change.
 *
 * Written as JSON in a template literal rather than as an object literal so
 * that comparison can be a `JSON.parse` on both sides rather than a regex per
 * number.
 *
 * `rows` are the row spans that must not intersect. `regions` are the boxes
 * `hud-has-all-five` samples, each with the exact colour that proves its element
 * drew: every plate and bar closes with a `hudFrame` outline, and the name has
 * no frame at all, so it is proven by its own ink instead.
 */
const HUD_BAND = JSON.parse(`{
  "rows": [
    { "id": "name",    "top": 16,  "bottom": 36  },
    { "id": "health",  "top": 40,  "bottom": 58  },
    { "id": "gauge",   "top": 62,  "bottom": 78  },
    { "id": "callout", "top": 80,  "bottom": 100 },
    { "id": "readout", "top": 104, "bottom": 122 },
    { "id": "bank",    "top": 126, "bottom": 144 }
  ],
  "regions": [
    { "id": "p1-portrait", "x": 24,  "y": 12, "width": 44,  "height": 44 },
    { "id": "p1-name",     "x": 76,  "y": 16, "width": 160, "height": 20 },
    { "id": "p1-health",   "x": 76,  "y": 40, "width": 328, "height": 18 },
    { "id": "p1-meter",    "x": 76,  "y": 62, "width": 328, "height": 16 },
    { "id": "p1-pips",     "x": 412, "y": 28, "width": 30,  "height": 12 },
    { "id": "p2-portrait", "x": 892, "y": 12, "width": 44,  "height": 44 },
    { "id": "p2-name",     "x": 724, "y": 16, "width": 160, "height": 20 },
    { "id": "p2-health",   "x": 556, "y": 40, "width": 328, "height": 18 },
    { "id": "p2-meter",    "x": 556, "y": 62, "width": 328, "height": 16 },
    { "id": "p2-pips",     "x": 518, "y": 28, "width": 30,  "height": 12 },
    { "id": "timer",       "x": 450, "y": 12, "width": 60,  "height": 44 }
  ]
}`);

/**
 * The exact colours the HUD paints, and nothing else on the canvas does.
 *
 * Exact `#rrggbb` matches rather than a brightness threshold, because the
 * backdrop is drawn full-frame *behind* the HUD: the dusk sky is bright at the
 * top of the arena, so "this box has bright pixels in it" is true of every box
 * whether or not a HUD element drew there. A box that contains its own element's
 * declared colour is a statement about the element.
 *
 * `hudFrame` closes every bar and every plate. The name has no frame, so it is
 * proven by `--tb-ink`, and `gold` is what a won round's pip fills with.
 */
const HUD_FRAME_RGB = [0x5a, 0x64, 0x80];
const HUD_NAME_RGB = [0xf5, 0xf5, 0xf0];
const HUD_GOLD_RGB = [0xff, 0xd2, 0x4a];

/** Pixels of the proving colour below which a region counts as empty. */
const HUD_REGION_INK_MIN = 30;

/**
 * The match-end overlay band, copied from `apps/web/src/render/renderer.ts`
 * (Story 12.7) -- the same standing reason `HUD_BAND` and `ARENA_TOP_PX` are
 * copies: this file cannot import a `.ts` module. `renderer.test.ts` reads this
 * literal off disk and pins it to `MATCH_END_OVERLAY_TOP`.
 *
 * `match-end-overlay` samples gold in this centre band. It sits below the HUD
 * and below `ARENA_TOP_PX`, so at frame 0 the only thing behind it is the
 * backdrop -- which paints no exact arcade gold -- and the ending word's gold is
 * the ink that is absent at the start and present at the end.
 */
const MATCH_END_OVERLAY_TOP = 180;
const MATCH_END_BAND_HEIGHT = 40;
/**
 * Wide enough to catch the ending word wherever it lands: `TIME OVER` is centred,
 * but `K.O.` sits over the losing fighter's half (renderer's
 * `MATCH_END_SIDE_BASIS_POINTS`, ~269/691 px on a 960 backbuffer). A narrow
 * centre band would see the timeout word and be blind to the KO one -- and to a
 * KO word that regressed off-canvas. This band spans 220..740, covering both KO
 * positions and the centred timeout, while staying below the HUD and above the
 * fighters so frame 0 still carries no gold here.
 */
const MATCH_END_BAND_WIDTH = 520;
/** Gold pixels the ending word must carry for the overlay to have drawn. */
const MATCH_END_GOLD_MIN = 20;

/**
 * The arena's lower bound, in backbuffer pixels from the bottom.
 *
 * `renderer.ts`'s `FLOOR_INSET` is 40: the floor rule is drawn at
 * `height - 40` in `theme.ink`, which is the brightest value on the canvas and
 * spans the frame edge to edge. Sampling through it would make every ink check
 * below report the floor rather than a fighter, so the arena band stops
 * strictly above it -- which is also exactly what Story 12.3's first acceptance
 * criterion asks for ("above the floor line").
 */
const FLOOR_INSET_PX = 40;

/**
 * Max channel above which a pixel counts as sprite ink.
 *
 * Measured, not guessed. On the Story 12-2 captures the backdrop's brightest
 * pixel anywhere in the arena band is 140 (the dimmed dusk mountains; `dim` is
 * 0.55 toward `#0a0a0a`) while the fighters carry thousands of pixels above
 * 190. 160 sits in the gap with room on both sides, so the check separates a
 * fighter from the scenery it is standing in front of rather than measuring
 * total ink -- which `canvas-not-blank` already does and which cannot tell a
 * drawn fighter from a drawn mountain.
 */
const SPRITE_INK_MIN = 160;

/** How many columns at each edge count as "the frame is cutting the fighter". */
const EDGE_COLUMNS = 4;

/**
 * Story 12.8: the hit flash and the debug-hitbox regression, measured.
 *
 * `FLASH_WHITE_MIN` is the *minimum* channel a pixel needs to count as the
 * flash. The struck fighter's silhouette is composited additively in white, so
 * a flashed pixel clamps to 255/255/255; the backdrop's brightest pixel in the
 * arena band is 140 and the fighters' own colours (accent `#c8ff00`, warn
 * `#ff3b30`) have a zero or near-zero channel, so a high *min* separates the
 * additive-white flash from every bright thing that is not it. Sampled below
 * `ARENA_TOP_PX` and above `FLOOR_INSET_PX`, so the near-white HUD name and the
 * `#f5f5f0` floor rule are both out of frame.
 *
 * `FLASH_BLOB_MIN` is the size of the *largest contiguous* near-white region a
 * hit frame must carry. A raw near-white *count* cannot serve: an independent
 * review of this story proved a count-and-spread check passed unchanged on the
 * parent commit -- no flash code at all -- because the pre-existing Story 11.2
 * impact sparks composite additively too and scatter near-white spark cores
 * across the band. What those sparks are *not* is one fighter-sized blob. The
 * flash drives a whole contiguous silhouette to white; the sparks are a
 * confetti of small components. So the check measures the single largest
 * 4-connected near-white component, which the flash owns and the sparks cannot
 * fake, and requires it to appear on a struck frame and be absent on an unstruck
 * one. The threshold was calibrated against a flash-off baseline (see the story
 * finding): sparks/KO cores top out well under it, the flash clears it severalfold.
 *
 * `WARN_RGB` is `--tb-warn` exactly; `no-debug-hitbox` fails a frame whose warn
 * pixels form a bounding box with inked edges and an empty interior -- the
 * hollow rectangle Story 4.3 drew and this story removed. `WARN_BOX_MIN` keeps a
 * scatter of warn damage-number pixels from being read as a box.
 */
const FLASH_WHITE_MIN = 248;
const FLASH_BLOB_MIN = 900;
const WARN_RGB = [0xff, 0x3b, 0x30];
const WARN_BOX_MIN = 60;

/**
 * Per visible arena canvas under `host`: the largest contiguous near-white
 * region (the flash), and whether warn pixels form a hollow rectangle, in the
 * arena band.
 *
 * One probe for both Story 12.8 checks, so `hit-reads-as-impact` and
 * `no-debug-hitbox` describe the same frame. A cinematic (letterbox) frame is
 * reported and excluded on the same terms `arenaInkProbe` uses: the plate's
 * white slam would read as one enormous flash.
 */
const arenaHitProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return null;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const lastRow = ctx.getImageData(0, canvas.height - 1, canvas.width, 1).data;
  let black = 0;
  for (let x = 0; x < canvas.width; x += 1) {
    const i = x * 4;
    if (lastRow[i] === 0 && lastRow[i + 1] === 0 && lastRow[i + 2] === 0) black += 1;
  }
  if (black >= Math.floor(canvas.width * 0.9)) return { cinematic: true, whiteBlob: 0, warnCount: 0, hollowWarn: false };

  const top = ${ARENA_TOP_PX};
  const bottom = canvas.height - ${FLOOR_INSET_PX};
  if (bottom <= top) return { cinematic: false, whiteBlob: 0, warnCount: 0, hollowWarn: false };
  const W = canvas.width;
  const H = bottom - top;
  const data = ctx.getImageData(0, top, W, H).data;
  const warn = ${JSON.stringify(WARN_RGB)};

  const near = new Uint8Array(W * H);
  let warnCount = 0;
  let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
  const warnSet = new Set();
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = y * W + x;
      const i = p * 4;
      if (data[i + 3] <= 8) continue;
      if (Math.min(data[i], data[i + 1], data[i + 2]) >= ${FLASH_WHITE_MIN}) near[p] = 1;
      if (data[i] === warn[0] && data[i + 1] === warn[1] && data[i + 2] === warn[2]) {
        warnCount += 1;
        warnSet.add(p);
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }

  // Largest 4-connected near-white component, iterative flood fill.
  let whiteBlob = 0;
  const stack = [];
  for (let p = 0; p < near.length; p += 1) {
    if (near[p] !== 1) continue;
    let size = 0;
    stack.push(p);
    near[p] = 2;
    while (stack.length > 0) {
      const q = stack.pop();
      size += 1;
      const qx = q % W;
      const qy = (q - qx) / W;
      if (qx > 0 && near[q - 1] === 1) { near[q - 1] = 2; stack.push(q - 1); }
      if (qx < W - 1 && near[q + 1] === 1) { near[q + 1] = 2; stack.push(q + 1); }
      if (qy > 0 && near[q - W] === 1) { near[q - W] = 2; stack.push(q - W); }
      if (qy < H - 1 && near[q + W] === 1) { near[q + W] = 2; stack.push(q + W); }
    }
    if (size > whiteBlob) whiteBlob = size;
  }

  let hollowWarn = false;
  if (warnCount >= ${WARN_BOX_MIN} && maxx - minx >= 8 && maxy - miny >= 8) {
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    let topEdge = 0, botEdge = 0, leftEdge = 0, rightEdge = 0;
    for (let x = minx; x <= maxx; x += 1) {
      if (warnSet.has(miny * W + x)) topEdge += 1;
      if (warnSet.has(maxy * W + x)) botEdge += 1;
    }
    for (let y = miny; y <= maxy; y += 1) {
      if (warnSet.has(y * W + minx)) leftEdge += 1;
      if (warnSet.has(y * W + maxx)) rightEdge += 1;
    }
    const edgesInked = topEdge / bw >= 0.6 && botEdge / bw >= 0.6 && leftEdge / bh >= 0.6 && rightEdge / bh >= 0.6;
    const perimeter = topEdge + botEdge + leftEdge + rightEdge;
    const interior = warnCount - perimeter;
    const interiorArea = Math.max(1, (bw - 2) * (bh - 2));
    hollowWarn = edgesInked && interior / interiorArea <= 0.15;
  }

  return { cinematic: false, whiteBlob, warnCount, hollowWarn };
})()`;

/**
 * Where sprite ink falls across an arena canvas, per visible canvas.
 *
 * One probe, two checks. `fighters-inside-frame` reads `edgeInk`; the framing
 * check reads `outerFifthInk` and `middleInk`. Splitting them into two page
 * evaluations would sample two different frames of a running fight, and the
 * whole point of both is that they describe the same picture.
 *
 * ## The Ultimate cinematic, and why it is excluded rather than tolerated
 *
 * The plate half of the cinematic is **screen space by design**
 * (`juice-draw.ts`, `drawCinematicPlate`): the caster's portrait slides in from
 * `viewport.width + portraitWidth` and is therefore *supposed* to cross the
 * frame's right edge, the orb blooms at its hand, and the slam fills the whole
 * viewport. None of that is a fighter clipped by the frame, and a check that
 * counted it would fail at random -- which is exactly what happened on the
 * first run of these checks: `#spectate` reported `edge=27@255 span=403..959`
 * on one run and `edge=0 span=382..563` on the next, because Spectate autoplays
 * a randomly chosen Match and one of them threw an Ultimate as the probe fired.
 * A gate that fails by luck is worse than no gate.
 *
 * So a canvas whose frame is *letterboxed* is skipped, and the skip is
 * reported rather than silent. The detector is the plate's own bottom bar:
 * `ARENA_PALETTE.curtain` is `#000000` exactly, and nothing else on this canvas
 * paints exact black -- the ground is `#0a0a0a` and the backdrop dims toward it
 * without reaching it. The slam's full-viewport flash is caught separately, by
 * counting rows that are ink nearly all the way across; a canvas that is mostly
 * such rows is a full-frame effect rather than a fight.
 *
 * Both exclusions are one-way: a canvas that is skipped contributes nothing,
 * and a check every canvas skipped fails rather than passing on an empty set.
 */
const arenaInkProbe = (hostSelector) => `(() => {
  const scope = ${hostSelector === null ? 'document' : `document.querySelector(${JSON.stringify(hostSelector)})`};
  if (!scope) return [];
  return [...scope.querySelectorAll('canvas')]
    .filter((c) => {
      const rect = c.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((c) => {
      const host = c.closest('#app, #arcade, #spectate');
      const out = {
        host: host ? host.id : null,
        width: c.width,
        edgeInk: 0,
        brightestEdge: 0,
        outerFifthInk: 0,
        middleInk: 0,
        leftmost: null,
        rightmost: null,
        samples: [],
        cinematic: false,
      };
      const ctx = c.getContext('2d');
      const top = ${ARENA_TOP_PX};
      const bottom = c.height - ${FLOOR_INSET_PX};
      if (!ctx || bottom <= top) return out;
      const rowIsFullFrame = Math.floor(c.width * 0.9);

      // The letterbox, read off the canvas's own bottom row.
      const lastRow = ctx.getImageData(0, c.height - 1, c.width, 1).data;
      let black = 0;
      for (let x = 0; x < c.width; x += 1) {
        const i = x * 4;
        if (lastRow[i] === 0 && lastRow[i + 1] === 0 && lastRow[i + 2] === 0) black += 1;
      }
      if (black >= rowIsFullFrame) {
        out.cinematic = true;
        return out;
      }

      const data = ctx.getImageData(0, top, c.width, bottom - top).data;
      const fifth = Math.floor(c.width / 5);
      let fullFrameRows = 0;
      for (let y = 0; y < bottom - top; y += 1) {
        const row = [];
        for (let x = 0; x < c.width; x += 1) {
          const i = (y * c.width + x) * 4;
          if (data[i + 3] <= 8) continue;
          const m = Math.max(data[i], data[i + 1], data[i + 2]);
          if (m >= ${SPRITE_INK_MIN}) row.push([x, m]);
        }
        if (row.length >= rowIsFullFrame) {
          fullFrameRows += 1;
          continue;
        }
        for (const [x, m] of row) {
          if (x < ${EDGE_COLUMNS} || x >= c.width - ${EDGE_COLUMNS}) {
            out.edgeInk += 1;
            if (m > out.brightestEdge) out.brightestEdge = m;
            if (out.samples.length < 6) {
              const i2 = (y * c.width + x) * 4;
              out.samples.push(x + ',' + (y + top) + ':' + data[i2] + '/' + data[i2 + 1] + '/' + data[i2 + 2]);
            }
          }
          if (x < fifth || x >= c.width - fifth) out.outerFifthInk += 1;
          else out.middleInk += 1;
          if (out.leftmost === null || x < out.leftmost) out.leftmost = x;
          if (out.rightmost === null || x > out.rightmost) out.rightmost = x;
        }
      }
      // A canvas that is mostly full-frame rows is the slam, not a fight.
      if (fullFrameRows * 2 >= bottom - top) out.cinematic = true;
      return out;
    });
})()`;

/** One line per canvas, for a failure message that does not need a second run. */
const describeInk = (canvases) =>
  canvases
    .map(
      (c) =>
        `${c.host ?? '?'} edge=${c.edgeInk}${c.edgeInk > 0 ? `@${c.brightestEdge} [${(c.samples ?? []).join(' ')}]` : ''} span=${String(c.leftmost)}..${String(c.rightmost)} of ${c.width}`,
    )
    .join(' | ');

/** A canvas with no sprite ink at all passes every ink *absence* check vacuously. */
const hasSpriteInk = (c) => c.leftmost !== null && c.rightmost !== null;

/**
 * Canvases a framing check can speak about, and a verdict that is never vacuous.
 *
 * `judged` drops any canvas showing an Ultimate cinematic (see `arenaInkProbe`).
 * `verdict` then fails if *every* canvas was dropped, so "the cinematic was on
 * screen on all three surfaces" reports as a failure to measure rather than as
 * a pass -- the same rule the harness catch at the bottom of this file follows.
 */
const judged = (canvases) => canvases.filter((c) => !c.cinematic);

const verdict = (canvases, holds) => {
  const measured = judged(canvases);
  return measured.length > 0 && measured.every(holds);
};

const skipNote = (canvases) => {
  const skipped = canvases.filter((c) => c.cinematic).map((c) => c.host ?? '?');
  return skipped.length === 0 ? '' : ` (cinematic, not judged: ${skipped.join(', ')})`;
};

const spanOf = (c) => (hasSpriteInk(c) ? c.rightmost - c.leftmost : 0);
const spanCentreOf = (c) => (hasSpriteInk(c) ? (c.leftmost + c.rightmost) / 2 : 0);

/**
 * The widest the pair may read, as a fraction of the canvas.
 *
 * Measured off `<REF>/shots/04_local_match.png`, where the two fighters and the
 * gap between them occupy about a third of the frame's width. This build at 1:1
 * -- the mapping this story replaces -- put the same pair across 44% of the
 * frame at the opening positions; with the camera it reads at 26%. The bound
 * sits between the two with margin on both sides, which is what makes the check
 * fail on the defect rather than merely describe the fix.
 *
 * An independent review found the first version of this check -- "some ink in
 * the middle three fifths, none in the outer fifth" -- passing unchanged on the
 * pre-camera build, because at the *opening* positions the old mapping put the
 * pair at 216..744 of 960, which is inside the middle three fifths. The story's
 * acceptance criterion says that much and no more; this is the same criterion
 * with the number that separates the two pictures added to it.
 */
const MAX_PAIR_SPAN_RATIO = 0.35;

/** Ink below this is a stray pixel, not a pair of fighters, and must not satisfy "the fight is framed". */
const MIN_FIGHT_INK = 500;

const framesTheFight = (c) =>
  hasSpriteInk(c) &&
  c.outerFifthInk === 0 &&
  c.middleInk >= MIN_FIGHT_INK &&
  spanOf(c) <= c.width * MAX_PAIR_SPAN_RATIO;

const describeFraming = (c) =>
  `${c.host ?? '?'} middle=${c.middleInk} outerFifth=${c.outerFifthInk} span=${String(c.leftmost)}..${String(c.rightmost)} (${((spanOf(c) / c.width) * 100).toFixed(1)}% of ${c.width})`;

/**
 * Whether the fight sits in the middle third of the frame.
 *
 * The universal half of the framing check, and the only half that can be asked
 * of `#app` and `#spectate`: both autoplay, so neither is ever caught at a
 * Match's opening positions, and the span bound above is a statement about the
 * opening. What *is* true of every frame under a clamped camera is that the
 * pair's centre of ink stays near the frame's centre -- which is exactly the
 * property Story 12.1 found violated ("fighters sit far right with roughly four
 * fifths of the frame empty") on a surface that never leaves its opening third.
 */
const fightIsCentred = (c) =>
  hasSpriteInk(c) &&
  spanCentreOf(c) >= c.width / 3 &&
  spanCentreOf(c) <= (c.width * 2) / 3;

const describeCentring = (c) =>
  `${c.host ?? '?'} ink centre ${hasSpriteInk(c) ? spanCentreOf(c).toFixed(0) : 'none'} of ${c.width}`;

/**
 * The pixel hash of the arena region (below the HUD) of the single visible
 * canvas under `host`, or `null` when there is none.
 */
const hostArenaHashProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return null;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const top = ${ARENA_TOP_PX};
  if (canvas.height <= top) return null;
  const data = ctx.getImageData(0, top, canvas.width, canvas.height - top).data;
  let hash = 0;
  for (let i = 0; i < data.length; i += 28) {
    hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) | 0;
  }
  return hash;
})()`;

/**
 * Story 12.10: the arena split into a far strip and a near strip, for
 * `stage-parallax-has-depth`.
 *
 * The backdrop has depth if, when the camera pans, the near (lower) part of the
 * frame shifts by more pixels than the far (upper) part. The far strip sits just
 * below the HUD, above where the fighters ever reach, so what changes there is
 * the backdrop and only the backdrop -- a flat, non-parallaxed backdrop would
 * not move it at all. The near strip sits just above the floor, where the near
 * layer (and the fighters) live. Each strip is returned as a coarse grid of
 * `r+g+b` samples; the two are diffed in Node between a before-pan and an
 * after-pan reading.
 *
 * Same cinematic guard as the ink probes: a letterboxed frame (the Ultimate) is
 * reported so the check can skip it rather than read the plate's slam as motion.
 */
const PARALLAX_STRIP_HEIGHT = 48;
const PARALLAX_SAMPLE_STEP_X = 12;
const PARALLAX_SAMPLE_STEP_Y = 4;
const arenaStripsProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return null;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const lastRow = ctx.getImageData(0, canvas.height - 1, canvas.width, 1).data;
  let black = 0;
  for (let x = 0; x < canvas.width; x += 1) {
    const i = x * 4;
    if (lastRow[i] === 0 && lastRow[i + 1] === 0 && lastRow[i + 2] === 0) black += 1;
  }
  if (black >= Math.floor(canvas.width * 0.9)) return { cinematic: true, upper: [], lower: [] };

  const stripH = ${PARALLAX_STRIP_HEIGHT};
  const stepX = ${PARALLAX_SAMPLE_STEP_X};
  const stepY = ${PARALLAX_SAMPLE_STEP_Y};
  const sampleStrip = (top) => {
    const out = [];
    const data = ctx.getImageData(0, top, canvas.width, stripH).data;
    for (let y = 0; y < stripH; y += stepY) {
      for (let x = 0; x < canvas.width; x += stepX) {
        const i = (y * canvas.width + x) * 4;
        out.push(data[i] + data[i + 1] + data[i + 2]);
      }
    }
    return out;
  };

  const upperTop = ${ARENA_TOP_PX};
  const lowerTop = canvas.height - ${FLOOR_INSET_PX} - stripH;
  if (upperTop + stripH > lowerTop) return { cinematic: false, upper: [], lower: [] };
  return { cinematic: false, upper: sampleStrip(upperTop), lower: sampleStrip(lowerTop) };
})()`;

/** How far two samples must differ to count as changed -- a little slack for antialiasing. */
const PARALLAX_SAMPLE_DELTA = 24;
/** Samples that changed between two strip readings. */
const stripDiff = (before, after) => {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
    return -1;
  }
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) {
    if (Math.abs(before[i] - after[i]) > PARALLAX_SAMPLE_DELTA) changed += 1;
  }
  return changed;
};

/** Clicks the character-select card for stage `id` (Story 12.10). */
const pickStage = (id) => `(() => {
  const card = document.querySelector('[data-select-stage="' + ${JSON.stringify(id)} + '"]');
  if (!card) return { ok: false, why: 'no card for ' + ${JSON.stringify(id)} };
  card.click();
  return { ok: true, pressed: card.getAttribute('aria-pressed') };
})()`;

/** How many stage cards the character-select screen renders, for the drift guard. */
const STAGE_CARD_COUNT_PROBE = `document.querySelectorAll('[data-select-stage]').length`;

/**
 * The arena hashed in two halves, left and right, plus its sprite ink (Story
 * 12.5).
 *
 * One hash over the whole arena answers "did the picture change" and nothing
 * more, and that is not enough for a check about a *choice*: picking on the
 * visitor's side and dressing the opponent changes the picture just as much as
 * dressing the right fighter does. Two halves separate the two -- the side that
 * was picked must move and the side that was not must not -- and both Matches
 * are the same seed at the same Decision Point, so the untouched half is
 * byte-identical when the wiring is right.
 *
 * `ink` is sprite ink (the `SPRITE_INK_MIN` threshold, above the backdrop's
 * brightest pixel), not `CANVAS_PROBE`'s whole-canvas ratio: the mountain-dusk
 * backdrop fills the frame and reports ~98% on an arena with no fighters drawn
 * on it at all, so the whole-canvas floor cannot fail here and proves nothing.
 */
const arenaHalvesProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return null;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const top = ${ARENA_TOP_PX};
  const bottom = canvas.height - ${FLOOR_INSET_PX};
  if (bottom <= top) return null;
  const data = ctx.getImageData(0, top, canvas.width, bottom - top).data;
  const middle = Math.floor(canvas.width / 2);
  let left = 0, right = 0, ink = 0;
  for (let y = 0; y < bottom - top; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      const mixed = data[i] + data[i + 1] * 3 + data[i + 2] * 7;
      if (x < middle) left = (left * 31 + mixed) | 0;
      else right = (right * 31 + mixed) | 0;
      if (data[i + 3] > 8 && Math.max(data[i], data[i + 1], data[i + 2]) >= ${SPRITE_INK_MIN}) ink += 1;
    }
  }
  return { left, right, ink };
})()`;

/**
 * The HUD band of the one visible canvas under `host`, measured (Story 12.6).
 *
 * Returns, per named region, how many pixels carry each of the three proving
 * colours, plus a hash of the region -- one probe rather than three, so
 * `hud-has-all-five`, `hud-timer-counts-down` and `hud-round-pips-advance` all
 * describe the same frame. Splitting them would sample three frames of a
 * running fight and let one check's evidence contradict another's.
 *
 * `readoutBarInk` is the pixel half of `hud-no-overlap`: the count of bar-frame
 * pixels inside the readout's own rows, across the whole width. The defect
 * Story 12.1 recorded -- `HP 69` sharing rows with the bar under it -- is
 * exactly a non-zero reading here.
 *
 * A canvas showing the Ultimate cinematic reports `cinematic` and nothing else:
 * the plate covers the whole viewport by design, so every region would read as
 * the letterbox rather than as the HUD.
 */
const hudBandProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return null;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const lastRow = ctx.getImageData(0, canvas.height - 1, canvas.width, 1).data;
  let black = 0;
  for (let x = 0; x < canvas.width; x += 1) {
    const i = x * 4;
    if (lastRow[i] === 0 && lastRow[i + 1] === 0 && lastRow[i + 2] === 0) black += 1;
  }
  if (black >= Math.floor(canvas.width * 0.9)) return { cinematic: true };

  const band = ${JSON.stringify(HUD_BAND)};
  const frame = ${JSON.stringify(HUD_FRAME_RGB)};
  const nameInk = ${JSON.stringify(HUD_NAME_RGB)};
  const gold = ${JSON.stringify(HUD_GOLD_RGB)};
  const is = (data, i, rgb) => data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2];

  const regions = band.regions.map((region) => {
    const out = { id: region.id, frame: 0, ink: 0, gold: 0, colours: 0, hash: 0 };
    if (region.x < 0 || region.y < 0) return out;
    if (region.x + region.width > canvas.width || region.y + region.height > canvas.height) return out;
    const data = ctx.getImageData(region.x, region.y, region.width, region.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (is(data, i, frame)) out.frame += 1;
      if (is(data, i, nameInk)) out.ink += 1;
      if (is(data, i, gold)) out.gold += 1;
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      out.hash = (out.hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) | 0;
    }
    out.colours = seen.size;
    return out;
  });

  // The pixel half of hud-no-overlap: bar-frame ink inside the two text row
  // bands, across the whole width. A callout or a readout that shared rows with
  // a bar would find the bar's own outline in its band, which is the reading of
  // the two defects Story 12.1 photographed. (No backticks in here: this comment
  // lives inside a template literal, and one would end the probe mid-sentence.)
  const barInkIn = (id) => {
    const row = band.rows.find((entry) => entry.id === id);
    if (!row || row.bottom > canvas.height) return -1;
    const rows = ctx.getImageData(0, row.top, canvas.width, row.bottom - row.top).data;
    let count = 0;
    for (let i = 0; i < rows.length; i += 4) {
      if (is(rows, i, frame)) count += 1;
    }
    return count;
  };

  return {
    cinematic: false,
    regions,
    readoutBarInk: barInkIn('readout'),
    calloutBarInk: barInkIn('callout'),
  };
})()`;

/**
 * Drives the replay player's timeline to a percentage of its own length.
 *
 * The range input a visitor drags, dispatching the same `input` event their
 * drag does, so the check exercises Story 4.5's seek rather than reaching into
 * the clock. Returns the frame it landed on, which is what makes "two different
 * scrub positions" a claim the failure message can back up.
 */
const scrubTo = (percent) => `(() => {
  const input = document.querySelector('#app [data-timeline]');
  if (!input) return null;
  const max = Number.parseInt(input.getAttribute('max') ?? '0', 10);
  const value = Math.floor((max * ${percent}) / 100);
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return { max, value };
})()`;

/**
 * Distinct colours a portrait region must carry for the *face* to have drawn.
 *
 * An independent review of Story 12.6 found the first version of this check
 * counting only `hudFrame`, which is the plate's own outline: a surface that
 * lost its portrait sheet -- the exact shape of the regression Story 12.5 found
 * in Spectate -- would still draw an aura-filled framed box and still report
 * `p1-portrait:336`. A flat plate carries two colours. A decoded portrait
 * carries hundreds.
 */
const PORTRAIT_COLOURS_MIN = 8;

/** Gold pixels the timer plate must carry for its digits to have drawn. */
const TIMER_DIGIT_INK_MIN = 20;

/**
 * Gold pixels in the match-end overlay band of the one visible canvas under
 * `host` (Story 12.7).
 *
 * `match-end-overlay` reads this at two scrub positions: frame 0, where the band
 * is backdrop and carries no gold, and the film's tail, where the ending word is
 * drawn in `ARENA_PALETTE.gold`. Requiring the count to *rise* -- absent at the
 * start, present at the end -- is what makes the check a statement about the
 * overlay rather than about whatever else is on the canvas. A canvas showing the
 * Ultimate cinematic reports `cinematic`, on the same terms as `hudBandProbe`.
 */
const overlayBandProbe = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)});
  if (!host) return null;
  const canvas = [...host.querySelectorAll('canvas')].find((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const lastRow = ctx.getImageData(0, canvas.height - 1, canvas.width, 1).data;
  let black = 0;
  for (let x = 0; x < canvas.width; x += 1) {
    const i = x * 4;
    if (lastRow[i] === 0 && lastRow[i + 1] === 0 && lastRow[i + 2] === 0) black += 1;
  }
  if (black >= Math.floor(canvas.width * 0.9)) return { cinematic: true, gold: -1 };

  const gold = ${JSON.stringify(HUD_GOLD_RGB)};
  const bandTop = ${MATCH_END_OVERLAY_TOP};
  const bandHeight = ${MATCH_END_BAND_HEIGHT};
  const bandWidth = ${MATCH_END_BAND_WIDTH};
  const x0 = Math.round(canvas.width / 2) - Math.round(bandWidth / 2);
  if (x0 < 0 || bandTop + bandHeight > canvas.height) return { cinematic: false, gold: -1 };
  const data = ctx.getImageData(x0, bandTop, bandWidth, bandHeight).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === gold[0] && data[i + 1] === gold[1] && data[i + 2] === gold[2]) count += 1;
  }
  return { cinematic: false, gold: count };
})()`;

/**
 * Which HUD regions came back short of the ink that proves their element drew.
 *
 * Each region is judged on the colour only *it* can produce, never on total
 * brightness: the backdrop is painted full-frame behind the HUD, so "this box
 * has bright pixels in it" is true of every box whether or not anything drew.
 * And each is judged on the element's **content** where the element has any --
 * a plate's own frame proves a plate, and a plate is not a portrait.
 */
const emptyRegions = (regions) =>
  regions
    .filter((region) => {
      if (region.id.endsWith('-name')) return region.ink < HUD_REGION_INK_MIN;
      if (region.id.endsWith('-portrait')) {
        return region.frame < HUD_REGION_INK_MIN || region.colours < PORTRAIT_COLOURS_MIN;
      }
      if (region.id === 'timer') {
        return region.frame < HUD_REGION_INK_MIN || region.gold < TIMER_DIGIT_INK_MIN;
      }
      return region.frame < HUD_REGION_INK_MIN;
    })
    .map((region) => region.id);

/** Row spans that intersect. Empty is the passing state. */
const overlappingRows = (rows) => {
  const clashes = [];
  for (const [index, row] of rows.entries()) {
    for (const other of rows.slice(index + 1)) {
      if (row.top < other.bottom && other.top < row.bottom) {
        clashes.push(`${row.id}(${row.top}..${row.bottom}) x ${other.id}(${other.top}..${other.bottom})`);
      }
    }
  }
  return clashes;
};

// --------------------------------------------------------------------------
// the run
// --------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const labelIndex = args.indexOf('--label');
  const label = labelIndex >= 0 ? args[labelIndex + 1] : (process.env.VISUAL_GATE_LABEL ?? 'current');
  const shotDir = join(REPO_ROOT, 'docs', 'visual', label);

  const checks = [];
  /** Records one check. `ok: false` is a finding; the waiver file decides whether it is fatal. */
  const record = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${id}${detail ? ` — ${detail}` : ''}\n`);
  };

  await mkdir(shotDir, { recursive: true });

  let vite;
  let chrome;
  let cdp;
  let profileDir;

  try {
    // --- dev server ---------------------------------------------------------
    const sitePort = await freePort();
    // `--host 127.0.0.1` is not cosmetic. Vite's default host is `localhost`,
    // which on Windows resolves to `::1` first, so the server ends up listening
    // on IPv6 only and every probe against `127.0.0.1` times out looking at a
    // server that started fine. Pinning the family makes the address the gate
    // dials the address the server answers on.
    vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(sitePort), '--strictPort'], {
      cwd: WEB_DIR,
      stdio: 'ignore',
    });
    await waitForHttp(`http://127.0.0.1:${sitePort}/`, 30_000, 'The vite dev server');

    // --- browser ------------------------------------------------------------
    const debugPort = await freePort();
    profileDir = join(tmpdir(), `tb-visual-gate-${process.pid}`);
    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        // Determinism, not cosmetics: a host with reduced motion enabled puts
        // the player on its still-frame path, and every animation check below
        // would then measure something other than the change under test.
        //
        // The flag is kept because it is harmless and self-documenting, but it
        // does NOT do this on its own -- see `Emulation.setEmulatedMedia`
        // below, which is what actually does it.
        '--force-prefers-reduced-motion=0',
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const version = JSON.parse(await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 30_000, 'Headless Chrome'));
    if (version.webSocketDebuggerUrl === undefined) {
      throw new Error('Chrome started but published no browser DevTools endpoint.');
    }
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.attachToNewPage();

    // --- console capture ----------------------------------------------------
    const consoleFindings = [];
    const noteConsole = (level, text) => {
      if (!['error', 'warning'].includes(level)) return;
      if (CONSOLE_ALLOWLIST.some((allowed) => text.includes(allowed))) return;
      consoleFindings.push(`${level}: ${text}`);
    };
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      noteConsole(params.type === 'warning' ? 'warning' : params.type, text);
    });
    cdp.on('Log.entryAdded', (params) => noteConsole(params.entry.level, params.entry.text));
    cdp.on('Runtime.exceptionThrown', (params) =>
      consoleFindings.push(`uncaught: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`),
    );

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    // --- reduced motion, off ------------------------------------------------
    //
    // Measured on 2026-08-10, during Story 12.4: headless Chrome answers
    // `matchMedia('(prefers-reduced-motion: reduce)').matches` with **true**,
    // and `--force-prefers-reduced-motion=0` does not change that -- the switch
    // is presence-only, so passing `=0` reads as passing it. Verified by
    // `--dump-dom` against a page that prints the query, with the flag and
    // without: `true` both times.
    //
    // So every run of this gate since Story 12.1 has measured the *reduced*
    // product. That matters more than it sounds: `player/clock.ts` under the
    // preference emits the final frame once and stops, `spectate/panel.ts`
    // declines to start its stream, and `juice.ts` drops the shake and the
    // particles. A check asserting that a hidden canvas does not repaint would
    // have passed on a page with no router at all, because nothing was moving
    // in the first place.
    //
    // `Emulation.setEmulatedMedia` is the lever that works. It is set on the
    // page session and survives every navigation the run makes.
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });

    /**
     * Loads the page at `route` as a fresh document.
     *
     * The query parameter is not decoration. Two URLs differing only in their
     * fragment are the *same document* to the browser, so `Page.navigate` from
     * `/#/watch` to `/` is a same-document navigation that fires no load event
     * and would leave the gate waiting fifteen seconds for one. A distinct
     * query makes every one of these a real navigation, which is also what
     * makes the reload check below a reload rather than a hash edit.
     */
    const load = async (tag, route) => {
      const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
      await cdp.send('Page.navigate', {
        url: `http://127.0.0.1:${sitePort}/?run=${encodeURIComponent(tag)}#${route}`,
      });
      await Promise.race([loaded, sleep(15_000)]);
    };

    /** Moves between screens the way a visitor's click does: by setting the hash. */
    const goto = async (route) => {
      await cdp.evaluate(`(() => { location.hash = ${JSON.stringify(`#${route}`)}; return location.hash; })()`);
      // Long enough for the router's `hashchange` to run, the screen to lay
      // out, and a resumed clock to paint at least one frame.
      await sleep(500);
    };

    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });
      await load(viewport.name, '/');

      // The asset upgrades are deliberately off the critical path (see
      // `startup.ts`): sprites and the backdrop swap into an already-running
      // fight. A capture taken on load correctly shows the block artist and
      // proves nothing, so the wait is part of the measurement.
      await sleep(2500);

      // --- C0a hidden-screens-are-idle, on the load path -------------------
      // Sampled here, before a single navigation, because this is the state a
      // visitor actually arrives in: every panel has mounted and started
      // itself, and the router's *first* apply is what has to stop them. The
      // later sample cannot see a failure here -- it only ever hashes screens
      // the run has already left -- and the first version of this router was
      // green there while painting two hidden canvases at 60fps on every load.
      const idleOnLoadBefore = (await cdp.evaluate(CANVAS_PROBE)).filter((c) => !c.visible);
      await sleep(ANIMATION_SAMPLE_MS);
      const idleOnLoadAfter = (await cdp.evaluate(CANVAS_PROBE)).filter((c) => !c.visible);
      const movedOnLoad = idleOnLoadBefore.filter(
        (c, index) => idleOnLoadAfter[index]?.hash !== c.hash,
      );
      record(
        `hidden-screens-are-idle-on-load-${viewport.name}`,
        idleOnLoadBefore.length > 0 &&
          idleOnLoadBefore.length === idleOnLoadAfter.length &&
          movedOnLoad.length === 0,
        idleOnLoadBefore.length === 0
          ? 'no off-screen canvas found, so nothing was measured'
          : `${idleOnLoadBefore.length} off-screen canvas(es) on the landing screen${movedOnLoad.length === 0 ? ', none repainted' : ` REPAINTED: ${movedOnLoad.map((c) => c.host ?? '?').join(', ')}`}`,
      );

      // --- C0 the cabinet: one screen at a time, and it fits ----------------
      // Every screen is walked, not just the ones with a canvas: the overflow
      // criterion says "when the page loads *and when each screen is shown*",
      // and the 992px canvas that caused it lives on a screen a visitor has to
      // navigate to now.
      const screenReadings = [];
      for (const route of SCREEN_ROUTES) {
        await goto(route);
        screenReadings.push({
          route,
          boxes: await cdp.evaluate(SCREEN_BOXES_PROBE),
          overflow: await cdp.evaluate(OVERFLOW_PROBE),
        });
      }

      const wrongCount = screenReadings.filter(
        (reading) => reading.boxes.filter((box) => box.area > 0).length !== 1,
      );
      // The drift guard the duplicated `SCREEN_ROUTES` above needs. Without it
      // a screen added to `shell/screens.ts` and forgotten here is simply never
      // visited, and the count of routes walked -- which is what this line used
      // to report -- says nothing about that, because it counts this file's own
      // list. Comparing against the DOM's `[data-screen]` count is the only
      // reading that comes from the other side.
      const declaredScreens = screenReadings[0]?.boxes.length ?? 0;
      record(
        `one-screen-at-a-time-${viewport.name}`,
        screenReadings.length > 0 &&
          wrongCount.length === 0 &&
          declaredScreens === SCREEN_ROUTES.length,
        declaredScreens !== SCREEN_ROUTES.length
          ? `the page declares ${declaredScreens} [data-screen] sections but this gate walks ${SCREEN_ROUTES.length} routes — SCREEN_ROUTES has drifted from shell/screens.ts`
          : wrongCount.length === 0
          ? `${screenReadings.length} screens, exactly one visible on each`
          : wrongCount
              .map(
                (reading) =>
                  `${reading.route}: ${reading.boxes
                    .filter((box) => box.area > 0)
                    .map((box) => `#${box.id}`)
                    .join('+') || 'none'} visible`,
              )
              .join(' | '),
      );

      // --- C0b the route survives a reload ---------------------------------
      // A route that does not survive a reload is a tab strip. This is a real
      // cross-document load straight at `#/watch`, which is also what a
      // visitor pasting the URL does.
      await load(`${viewport.name}-reload`, '/watch');
      await sleep(1200);
      const afterReload = await cdp.evaluate(SCREEN_BOXES_PROBE);
      const shownAfterReload = afterReload.filter((box) => box.area > 0).map((box) => box.id);
      record(
        `route-survives-reload-${viewport.name}`,
        shownAfterReload.length === 1 && shownAfterReload[0] === 'spectate',
        `loaded #/watch, showing ${shownAfterReload.join('+') || 'nothing'}`,
      );
      // Back to a fresh page for the rest of the run, so the arcade Match below
      // starts from the same state it always did.
      await load(viewport.name, '/');
      await sleep(2500);

      // --- C0c the back button ---------------------------------------------
      // Driven through the browser's own history, not through the hash: the
      // criterion is about the back button, and the unit tests can only model
      // one. Two navigations, then back, then forward.
      await goto('/play');
      await goto('/watch');
      await cdp.evaluate('(() => { history.back(); return true; })()');
      await sleep(800);
      const backTo = (await cdp.evaluate(SCREEN_BOXES_PROBE))
        .filter((box) => box.area > 0)
        .map((box) => box.id);
      await cdp.evaluate('(() => { history.forward(); return true; })()');
      await sleep(800);
      const forwardTo = (await cdp.evaluate(SCREEN_BOXES_PROBE))
        .filter((box) => box.area > 0)
        .map((box) => box.id);
      record(
        `back-button-walks-the-screens-${viewport.name}`,
        backTo.length === 1 && backTo[0] === 'arcade' && forwardTo.length === 1 && forwardTo[0] === 'spectate',
        `after back: ${backTo.join('+') || 'nothing'}; after forward: ${forwardTo.join('+') || 'nothing'}`,
      );

      // --- C2 no-horizontal-overflow ---------------------------------------
      const overflowReadings = screenReadings.map((reading) => ({
        route: reading.route,
        overflow: reading.overflow,
      }));
      if (viewport.mobile) {
        // The arcade stage is `display: none` until a Match is running, so the
        // screen walk above never laid out its 960px canvas at 390px -- the one
        // canvas a phone visitor actually meets in Play-vs-CPU was the only one
        // this check could not see. Start a Match and measure it. The Match is
        // left running, which also gives the mobile capture a live fight and
        // gives `hidden-screens-are-idle` a second canvas that would move.
        await goto('/play');
        const startedOnPhone = await cdp.evaluate(clickIn('#arcade', '^play vs cpu$'));
        await sleep(1500);
        const phoneArcade = await cdp.evaluate(hostCanvasProbe('#arcade'));
        record(
          'arcade-live-canvas-mobile',
          startedOnPhone.ok === true && phoneArcade.visible > 0,
          `started=${String(startedOnPhone.ok)} canvases=${phoneArcade.canvases} visible=${phoneArcade.visible}`,
        );
        overflowReadings.push({
          route: '/play (match running)',
          overflow: await cdp.evaluate(OVERFLOW_PROBE),
        });

        const worst = overflowReadings.reduce((a, b) =>
          b.overflow.scrollWidth > a.overflow.scrollWidth ? b : a,
        );
        const offenders = worst.overflow.offenders
          .map((o) => `${o.tag}.${o.cls || '-'}@${o.right}px`)
          .join(', ');
        record(
          'no-horizontal-overflow',
          overflowReadings.every(
            (reading) => reading.overflow.scrollWidth <= reading.overflow.clientWidth + 1,
          ),
          `widest screen ${worst.route}: scrollWidth=${worst.overflow.scrollWidth} clientWidth=${worst.overflow.clientWidth}${offenders ? ` widest: ${offenders}` : ''}`,
        );
      }

      // --- C1 arcade-live-canvas -------------------------------------------
      // The mode a visitor is most likely to try first. Today the Match runs
      // headlessly and there is no canvas in `#arcade` at all.
      if (!viewport.mobile) {
        // Story 12.4: navigate first. The Play button is on a screen now, and
        // the live arena does not paint while its screen is hidden.
        await goto('/play');
        const started = await cdp.evaluate(clickIn('#arcade', '^play vs cpu$'));
        await sleep(1200);
        const arcade = await cdp.evaluate(hostCanvasProbe('#arcade'));
        record(
          'arcade-live-canvas',
          started.ok === true && arcade.visible > 0,
          `started=${String(started.ok)} canvases=${arcade.canvases} visible=${arcade.visible}`,
        );

        // --- C1c camera-frames-the-fight (Story 12.3) ----------------------
        // Sampled here, before a single key is pressed, because this is the
        // only moment any surface is reliably at a Match's *opening positions*
        // -- the arcade Match hangs at its first Decision Point waiting for the
        // visitor (Story 12.2), so what is on screen is `startPosition`, which
        // is [320, 640] of a 0..960 arena. With the fighters 1:1 on the canvas
        // that put them in the middle third with the outer thirds empty; the
        // camera has to bring them in without pushing either into the outer
        // fifth on the way.
        const opening = await cdp.evaluate(arenaInkProbe('#arcade'));
        record(
          'camera-frames-the-fight',
          verdict(opening, framesTheFight),
          opening.length === 0
            ? 'no visible canvas under #arcade to frame'
            : `${opening.map(describeFraming).join(' | ')}${skipNote(opening)}`,
        );

        // --- C1b arcade-input-moves-fighter (Story 12.2) -------------------
        // The Match is now waiting on the visitor at its first Decision Point.
        // Thirty real ArrowRight keydowns walk the fighter across the stage; the
        // arena the fighter is drawn in must change between the first press and
        // the last. Driven through `keydown` on the page, not a call into the
        // panel, so it exercises the listener a keyboard reaches.
        //
        // Hashed below the HUD band: the `TICK` readout and the bars advance on
        // their own every Decision Point, so a whole-canvas hash would pass on a
        // frozen fighter. See `ARENA_TOP_PX`.
        const arcadeHashBefore = await cdp.evaluate(hostArenaHashProbe('#arcade'));
        // Story 12.10. The same centre-to-wall pan drives `stage-parallax-has-depth`:
        // sample a far strip and a near strip before the pan and after it, and the
        // near strip must move by more pixels than the far one. Read here, off the
        // one pan the gate already makes, rather than staging a second.
        const stripsBefore = await cdp.evaluate(arenaStripsProbe('#arcade'));
        for (let press = 0; press < 30; press += 1) {
          await cdp.evaluate(dispatchKeydown('#arcade [data-arcade-keys]', 'ArrowRight'));
          await sleep(40);
        }
        // Let the live clock draw through the states the presses queued. The
        // clock advances one film frame per animation-frame callback and 30
        // presses queue far more than that, so this waits for the drain rather
        // than sampling mid-flight -- see the story's note on live-view pacing.
        await sleep(4_000);
        const arcadeHashAfter = await cdp.evaluate(hostArenaHashProbe('#arcade'));
        record(
          'arcade-input-moves-fighter',
          arcadeHashBefore !== null && arcadeHashAfter !== null && arcadeHashBefore !== arcadeHashAfter,
          arcadeHashBefore === null
            ? 'no visible canvas under #arcade to drive'
            : `arena hash ${arcadeHashBefore} -> ${arcadeHashAfter}`,
        );

        // --- C1e stage-parallax-has-depth (Story 12.10) --------------------
        const stripsAfter = await cdp.evaluate(arenaStripsProbe('#arcade'));
        const cinematicStrip =
          stripsBefore === null ||
          stripsAfter === null ||
          stripsBefore.cinematic === true ||
          stripsAfter.cinematic === true;
        const farShift = cinematicStrip ? -1 : stripDiff(stripsBefore.upper, stripsAfter.upper);
        const nearShift = cinematicStrip ? -1 : stripDiff(stripsBefore.lower, stripsAfter.lower);
        record(
          'stage-parallax-has-depth',
          // The near strip moved (the fight and the near layer), the far strip
          // moved too (a flat backdrop would not, so this is what proves the
          // scene parallaxes at all), and the near strip moved strictly more --
          // which is depth. A cinematic frame is not judged.
          !cinematicStrip && farShift > 0 && nearShift > farShift,
          cinematicStrip
            ? 'a cinematic frame was on screen; parallax not judged this run'
            : `far strip changed ${farShift}, near strip changed ${nearShift} (near must exceed far, far must exceed 0)`,
        );

        // --- C1d fighters-inside-frame, at the wall (Story 12.3) -----------
        // Thirty ArrowRight presses is 30 * moveUnitsPerTick * ticksPerDecision
        // past `startPosition`, which is well past `arenaMax`: the fighter is
        // standing on the right wall. That is the case the 1:1 mapping drew
        // centred on the canvas's right edge, with half the sprite outside the
        // frame. Same check as the page sweep below, re-sampled where it used
        // to fail hardest.
        const atWall = await cdp.evaluate(arenaInkProbe('#arcade'));
        record(
          'fighters-inside-frame-at-the-wall',
          verdict(atWall, (c) => hasSpriteInk(c) && c.edgeInk === 0),
          atWall.length === 0
            ? 'no visible canvas under #arcade'
            : `${describeInk(atWall)}${skipNote(atWall)}`,
        );
      }

      // --- C3 the arena sweeps, one screen at a time (Story 12.4) ----------
      // Before the router these three checks read "every canvas on the page",
      // which was one measurement because every surface was mounted at once.
      // A cabinet shows one screen, so the sweep walks the three screens that
      // hold an arena and aggregates -- same coverage, three visits. Dropping
      // to whichever screen happened to be showing would have quietly narrowed
      // the sweep to one surface, which is exactly the hole Story 12.3's review
      // found in the first version of `fighters-inside-frame`.
      const canvases = [];
      const inkAcross = [];
      for (const route of ARENA_ROUTES) {
        await goto(route);
        canvases.push(...(await cdp.evaluate(CANVAS_PROBE)).filter((c) => c.visible));
        inkAcross.push(...(await cdp.evaluate(arenaInkProbe(null))));
      }
      const blank = canvases.filter((c) => c.visible && c.readable && c.inkRatio < MIN_INK_RATIO);
      record(
        `canvas-not-blank-${viewport.name}`,
        canvases.length > 0 && blank.length === 0,
        canvases.length === 0
          ? 'no canvas on the page at all'
          : `${canvases.length} canvas(es), ink ${canvases.map((c) => `${c.host ?? '?'}:${(c.inkRatio * 100).toFixed(1)}%`).join(' ')}`,
      );

      // --- C3b fighters-inside-frame (Story 12.3) ---------------------------
      // Every visible arena canvas across every arena screen, not just the one
      // this story was thinking about. The clipping was a property of the
      // coordinate mapping, so it was identical on all three surfaces, and a
      // check that swept one of them would have gone green on a camera wired
      // into the player and forgotten in Spectate.
      record(
        `fighters-inside-frame-${viewport.name}`,
        // `hasSpriteInk` is not decoration. Without it the check passes on a
        // canvas with no fighter on it at all -- a NaN camera scale paints
        // nothing, and `canvas-not-blank` still reports 98% ink because the
        // backdrop is drawn in screen space and survives whatever the camera
        // does. Two green checks over an arena with no fighters in it was the
        // hole an independent review of this story found.
        verdict(inkAcross, (c) => hasSpriteInk(c) && c.edgeInk === 0),
        inkAcross.length === 0
          ? 'no visible canvas to sample'
          : `${describeInk(inkAcross)}${skipNote(inkAcross)}`,
      );

      // --- C3c fight-is-centred (Story 12.3) --------------------------------
      // The framing check's universal half, on every surface. `#app` and
      // `#spectate` autoplay and are never at a Match's opening positions, so
      // the span bound cannot be asked of them -- but "the pair is near the
      // middle of the picture" can, and it is the property Story 12.1 recorded
      // as violated on `#app`.
      record(
        `fight-is-centred-${viewport.name}`,
        verdict(inkAcross, fightIsCentred),
        inkAcross.length === 0
          ? 'no visible canvas to sample'
          : `${inkAcross.map(describeCentring).join(' | ')}${skipNote(inkAcross)}`,
      );

      // --- C4 spectate-animates ---------------------------------------------
      // The Story 11-6 defect exactly: a surface holding one still frame while
      // every unit test about it stayed green.
      await goto('/watch');
      if (!viewport.mobile) {
        await cdp.evaluate(scrollIntoView('#spectate'));
        await cdp.evaluate(clickIn('#spectate', '^play$'));
        const before = await cdp.evaluate(CANVAS_PROBE);
        await sleep(ANIMATION_SAMPLE_MS);
        const after = await cdp.evaluate(CANVAS_PROBE);
        const spectateBefore = before.find((c) => c.host === 'spectate');
        const spectateAfter = after.find((c) => c.host === 'spectate');
        record(
          'spectate-animates',
          spectateBefore !== undefined && spectateAfter !== undefined && spectateBefore.hash !== spectateAfter.hash,
          spectateBefore === undefined
            ? 'no canvas under #spectate'
            : `hash ${spectateBefore.hash} -> ${spectateAfter?.hash}`,
        );
      }

      // --- C4b hidden-screens-are-idle (Story 12.4) -------------------------
      // `spectate-animates` inverted, and both must hold at once: the shown
      // surface animates, the hidden ones do not. Sampled here, on `#/watch`,
      // because that is the moment the page is at its most loaded -- the
      // replay player has a Match in it and (on desktop) the arcade Match is
      // mid-fight, so both hidden canvases carry a picture that *would* move if
      // nothing had stopped them.
      //
      // Whole-canvas hashes, deliberately, where the arcade movement check
      // hashes below the HUD: here a moving clock readout is exactly the
      // failure being looked for.
      //
      // The film is rewound first, and that is what makes the check bite. A
      // mutation run with every `onHide` removed passed on desktop and failed
      // only on mobile, because by the time the desktop path reached this point
      // the demo film had played itself out -- the hidden canvas was static for
      // a reason that had nothing to do with the router. Pressing Replay puts a
      // running clock behind the hidden canvas, so "it did not repaint" is a
      // statement about the screen being hidden rather than about the Match
      // being over.
      await goto('/replay');
      await cdp.evaluate(clickIn('#app', '^replay$'));
      await sleep(400);
      await goto('/watch');
      const hiddenBefore = (await cdp.evaluate(CANVAS_PROBE)).filter((c) => !c.visible);
      await sleep(ANIMATION_SAMPLE_MS);
      const hiddenAfter = (await cdp.evaluate(CANVAS_PROBE)).filter((c) => !c.visible);
      const moved = hiddenBefore.filter((c, index) => hiddenAfter[index]?.hash !== c.hash);
      record(
        `hidden-screens-are-idle-${viewport.name}`,
        // A run that found no hidden canvas measured nothing and must not
        // report a pass: with the router there is always at least one.
        hiddenBefore.length > 0 &&
          hiddenBefore.length === hiddenAfter.length &&
          moved.length === 0,
        hiddenBefore.length === 0
          ? 'no off-screen canvas found, so nothing was measured'
          : `${hiddenBefore.length} off-screen canvas(es)${moved.length === 0 ? ', none repainted' : ` REPAINTED: ${moved.map((c) => c.host ?? '?').join(', ')}`}`,
      );

      // --- C4d the HUD band (Story 12.6) ------------------------------------
      //
      // On the replay player, because it is the one surface whose playback
      // position this gate can *set*: the timer and the pips are read off a
      // scrub, and a check that waited for an autoplaying stream to reach an
      // interesting frame would pass or fail by luck.
      //
      // The three checks share one probe of one frame. `hud-has-all-five` reads
      // the region ink, `hud-no-overlap` reads the readout rows, and the timer
      // and pip checks scrub and re-read. Sampling separately would let one
      // check's evidence describe a frame another check never saw.
      if (!viewport.mobile) {
        // **All three arena surfaces, not the player alone.** An independent
        // review of Story 12.6 pointed out that a HUD element wired into one
        // surface and forgotten in another is this repository's signature
        // defect -- it is what Story 12.5 found in Spectate a story ago -- and
        // that a check reading `#app` only could not see it. The player is
        // still where the timer and the pips are read, because it is the one
        // surface whose playback position this gate can set.
        const bands = [];
        for (const route of ARENA_ROUTES) {
          await goto(route);
          await sleep(400);
          bands.push({ route, band: await cdp.evaluate(hudBandProbe(route === '/replay' ? '#app' : route === '/play' ? '#arcade' : '#spectate')) });
        }
        const judgedBands = bands.filter(
          (entry) => entry.band !== null && entry.band.cinematic !== true,
        );
        const shortfalls = judgedBands.flatMap((entry) =>
          emptyRegions(entry.band.regions).map((id) => `${entry.route}:${id}`),
        );
        record(
          'hud-has-all-five',
          judgedBands.length === ARENA_ROUTES.length && shortfalls.length === 0,
          judgedBands.length < ARENA_ROUTES.length
            ? `only ${judgedBands.length} of ${ARENA_ROUTES.length} arena surfaces could be read (${bands
                .filter((entry) => entry.band === null || entry.band.cinematic === true)
                .map((entry) => entry.route)
                .join(', ')})`
            : shortfalls.length === 0
            ? judgedBands
                .map(
                  (entry) =>
                    `${entry.route} ${entry.band.regions.length} regions ok (portrait colours ${entry.band.regions
                      .filter((r) => r.id.endsWith('-portrait'))
                      .map((r) => r.colours)
                      .join('/')}, timer gold ${entry.band.regions.find((r) => r.id === 'timer')?.gold})`,
                )
                .join(' | ')
            : `EMPTY: ${shortfalls.join(', ')}`,
        );

        await goto('/replay');
        const atStart = await cdp.evaluate(scrubTo(0));
        await sleep(500);
        const band = await cdp.evaluate(hudBandProbe('#app'));

        // Two halves, and both must hold. The declared row spans do not
        // intersect -- which is the criterion, and which `renderer.test.ts`
        // pins to the shipped constants -- and neither text band carries any
        // bar-frame ink, which is the pixel reading of the two defects Story
        // 12.1 photographed: the callout drawn on the gauge and the readout
        // sharing rows with the bar under it. A callout band that overlapped
        // the gauge would find the gauge's own outline inside it.
        const clashes = overlappingRows(HUD_BAND.rows);
        const textBandInk =
          band === null || band.cinematic === true ? -1 : band.readoutBarInk + band.calloutBarInk;
        record(
          'hud-no-overlap',
          clashes.length === 0 && textBandInk === 0,
          clashes.length > 0
            ? `row spans intersect: ${clashes.join(' | ')}`
            : textBandInk < 0
            ? 'no HUD frame to measure the text rows on'
            : `6 row spans disjoint; ${band.calloutBarInk} bar pixels in the callout's rows and ${band.readoutBarInk} in the readout's`,
        );

        // --- hud-timer-counts-down ------------------------------------------
        // Two scrub positions and then back to the first. The timer must read
        // differently at a later Decision Point *and* return to its first
        // reading when the visitor scrubs back -- which is what says it is a
        // function of the frame rather than of anything that has been counting
        // since the page loaded.
        const timerAt = (probe) => probe?.regions?.find((r) => r.id === 'timer')?.hash ?? null;
        const startHash = timerAt(band);
        await cdp.evaluate(scrubTo(60));
        await sleep(500);
        const midway = await cdp.evaluate(hudBandProbe('#app'));
        await cdp.evaluate(scrubTo(0));
        await sleep(500);
        const backAgain = await cdp.evaluate(hudBandProbe('#app'));
        const midHash = timerAt(midway);
        const backHash = timerAt(backAgain);
        record(
          'hud-timer-counts-down',
          startHash !== null &&
            midHash !== null &&
            startHash !== midHash &&
            startHash === backHash,
          `frame 0..${String(atStart?.max)}: timer ${String(startHash)} -> ${String(midHash)} -> ${String(backHash)}${
            startHash !== null && startHash === midHash ? ' — the timer did not change across the Match' : ''
          }${
            startHash !== null && startHash !== backHash ? ' — scrubbing back did not restore it' : ''
          }`,
        );

        // --- hud-round-pips-advance (Story 12.7) ----------------------------
        // Story 12.6 drew the pips empty and had nothing to count; this story is
        // what they count. At the film's tail the winning side's pip fills gold,
        // read off the log's own `result`. The waiver 12.6 recorded is deleted in
        // the same change, so a run that is green only because the waiver survived
        // is a failed story rather than a passed one.
        await cdp.evaluate(scrubTo(100));
        await sleep(500);
        const atEnd = await cdp.evaluate(hudBandProbe('#app'));
        const pipGold = (atEnd?.regions ?? [])
          .filter((region) => region.id.endsWith('-pips'))
          .reduce((total, region) => total + region.gold, 0);
        record(
          'hud-round-pips-advance',
          atEnd !== null && atEnd.cinematic !== true && pipGold > 0,
          atEnd === null
            ? 'no visible canvas under #app'
            : `${pipGold} gold pixels across both pip groups at the end of the Match`,
        );

        // --- match-end-overlay (Story 12.7) ---------------------------------
        // A Match finishing is an event, not a canvas that stops moving. The gate
        // scrubs to the film's tail and requires gold in the centre overlay band
        // -- the KO / TIME OVER word -- that frame 0 has none of. Both scrubs are
        // pure in the frame, so the screen goes down when the visitor scrubs away
        // from the end, which is what says it is drawn rather than latched.
        const overlayAtEnd = await cdp.evaluate(overlayBandProbe('#app'));
        await cdp.evaluate(scrubTo(0));
        await sleep(500);
        const overlayAtStart = await cdp.evaluate(overlayBandProbe('#app'));
        record(
          'match-end-overlay',
          overlayAtStart !== null &&
            overlayAtEnd !== null &&
            overlayAtStart.cinematic !== true &&
            overlayAtEnd.cinematic !== true &&
            overlayAtStart.gold === 0 &&
            overlayAtEnd.gold >= MATCH_END_GOLD_MIN,
          overlayAtEnd === null || overlayAtStart === null
            ? 'no visible canvas under #app'
            : `overlay gold frame 0: ${String(overlayAtStart.gold)} -> tail: ${String(overlayAtEnd.gold)}`,
        );
      }

      // --- C4e hit-reads-as-impact + no-debug-hitbox (Story 12.8) ----------
      //
      // Two checks off one probe. `hit-reads-as-impact` requires the struck
      // fighter's own pixels to differ from an unstruck frame by more than a
      // threshold: the additive white silhouette drives a hit frame's arena to
      // hundreds of near-white pixels an unstruck frame does not carry.
      // `no-debug-hitbox` requires that no sampled frame draws a hollow
      // warn-coloured rectangle -- the Story 4.3 bracket this story removed.
      //
      // Measured on the two surfaces the gate can bring to a landed hit without
      // luck: `#app` by scrubbing a deterministic committed film, and
      // `#spectate` by letting an autoplaying committed log (dense with hits)
      // run. `no-debug-hitbox` additionally samples `#arcade`, so the
      // regression guard covers all three even though the flash's presence is
      // asserted on the two that can be driven deterministically. All three
      // draw through the identical sprite-artist path (`animation.test.ts` pins
      // the flash composite; `startup.ts` dresses every surface from the same
      // `artistFor`).
      if (!viewport.mobile) {
        // A hit frame owns a large near-white blob; an unstruck one does not.
        // `flashes` is true when the biggest blob crosses the threshold on some
        // sampled frame and stays well under it on another -- the flash both
        // appears and is absent, which no constant surface and no confetti of
        // spark cores can satisfy.
        const blobs = (samples) => samples.map((s) => s.whiteBlob);
        const flashes = (samples) => {
          const b = blobs(samples);
          return b.length > 0 && Math.max(...b) >= FLASH_BLOB_MIN && Math.min(...b) < FLASH_BLOB_MIN / 2;
        };
        const describeBlob = (label, samples) => {
          const b = blobs(samples);
          return `${label} blob ${b.length ? `${Math.min(...b)}..${Math.max(...b)}` : 'none'}`;
        };

        await goto('/replay');
        const appHit = [];
        for (const pct of [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96]) {
          await cdp.evaluate(scrubTo(pct));
          await sleep(180);
          const sample = await cdp.evaluate(arenaHitProbe('#app'));
          if (sample !== null && sample.cinematic !== true) appHit.push(sample);
        }

        await goto('/watch');
        await cdp.evaluate(scrollIntoView('#spectate'));
        await cdp.evaluate(clickIn('#spectate', '^play$'));
        const specHit = [];
        for (let sample = 0; sample < 16; sample += 1) {
          await sleep(220);
          const reading = await cdp.evaluate(arenaHitProbe('#spectate'));
          if (reading !== null && reading.cinematic !== true) specHit.push(reading);
        }

        // `#arcade` for the regression sweep only. The Match resumes on /play;
        // feed a few real inputs so it advances through Decision Points that
        // draw fighters (and, when the CPU connects, a flash) rather than
        // hanging on its first.
        await goto('/play');
        const arcadeHit = [];
        for (let press = 0; press < 8; press += 1) {
          await cdp.evaluate(dispatchKeydown('#arcade [data-arcade-keys]', press % 2 === 0 ? 'ArrowRight' : 'z'));
          await sleep(160);
          const reading = await cdp.evaluate(arenaHitProbe('#arcade'));
          if (reading !== null && reading.cinematic !== true) arcadeHit.push(reading);
        }

        // Measured on the two surfaces a hit can be reached without luck: `#app`
        // by scrubbing a deterministic committed film, `#spectate` by letting an
        // autoplaying committed log (dense with hits) run. `#arcade` draws the
        // identical flash (one shared `artistFor` dresses all three), but its
        // Match hangs on the visitor and cannot be brought to a landed hit
        // deterministically -- so it is covered by `no-debug-hitbox` below and
        // by the shared-path unit test, not asserted here.
        record(
          'hit-reads-as-impact',
          flashes(appHit) && flashes(specHit),
          `${describeBlob('#app', appHit)} (min ${FLASH_BLOB_MIN}); ${describeBlob('#spectate', specHit)}`,
        );

        const allHit = [...appHit, ...specHit, ...arcadeHit];
        const hollow = allHit.filter((s) => s.hollowWarn);
        record(
          'no-debug-hitbox',
          allHit.length > 0 && hollow.length === 0,
          allHit.length === 0
            ? 'no arena frame could be sampled'
            : `${allHit.length} arena frames sampled across #app/#spectate/#arcade, ${hollow.length} with a hollow warn box`,
        );
      }

      // --- C4c character-select-reachable (Story 12.4, cleared by 12.5) -----
      // Waived by 12.4 with 12.5 as its owner; 12.5 built the screen and
      // deleted the waiver, so this check is load-bearing from here on.
      if (!viewport.mobile) {
        await goto('/select');
        const select = await cdp.evaluate(CHARACTER_SELECT_PROBE);
        record(
          'character-select-reachable',
          select.reached === true && select.found.length === 4,
          `showing #${select.screen ?? 'nothing'}, fighters named: ${select.found.join(', ') || 'none'}`,
        );

      }

      // --- C4f every-stage-draws (Story 12.10) ------------------------------
      // Iterates the stage list rather than a hardcoded count, so a stage added
      // and left unwired fails rather than ships. For each stage: pick it on the
      // select screen, let its scenery decode, then scrub the replay player to a
      // fixed frame and hash the arena below the HUD. The fighters are identical
      // across all six -- same log, same scrub frame -- so the only thing that
      // can change the hash is which stage was drawn. Two stages that both failed
      // to load would hash identically (a flat arena over the same fighters), so
      // requiring all six hashes distinct catches an unwired stage where an ink
      // floor cannot: the backdrop fills the frame and reports ~98% either way.
      if (!viewport.mobile) {
        // The drift guard the duplicated `STAGE_IDS` needs: the select screen
        // renders one card per stage in the module, so a mismatch here means the
        // gate's copy has drifted from `render/stages.ts`.
        await goto('/select');
        const stageCardCount = await cdp.evaluate(STAGE_CARD_COUNT_PROBE);

        const stageReadings = [];
        for (const id of STAGE_IDS) {
          await load(`${viewport.name}-stage-${id}`, '/select');
          // The packs and the stage are late upgrades to an already-running
          // page; a probe fired before they land measures the flat arena.
          await sleep(2500);
          const picked = await cdp.evaluate(pickStage(id));
          // The pick starts the fetch; this is the decode.
          await sleep(2000);
          await goto('/replay');
          await cdp.evaluate(scrubTo(40));
          await sleep(500);
          const hash = await cdp.evaluate(hostArenaHashProbe('#app'));
          const canvases = await cdp.evaluate(CANVAS_PROBE);
          const app = canvases.find((c) => c.host === 'app');
          stageReadings.push({
            id,
            picked: picked.ok === true && picked.pressed === 'true',
            hash,
            ink: app ? app.inkRatio : 0,
          });
        }
        const distinctHashes = new Set(stageReadings.map((r) => r.hash));
        const measured = stageReadings.every((r) => r.picked && r.hash !== null);
        const belowInk = stageReadings.filter((r) => r.ink < MIN_INK_RATIO);
        record(
          'every-stage-draws',
          stageCardCount === STAGE_IDS.length &&
            measured &&
            distinctHashes.size === STAGE_IDS.length &&
            belowInk.length === 0,
          stageCardCount !== STAGE_IDS.length
            ? `the page renders ${stageCardCount} stage cards but this gate iterates ${STAGE_IDS.length} — STAGE_IDS has drifted from render/stages.ts`
            : !measured
            ? `a stage did not pick or did not draw: ${stageReadings
                .map((r) => `${r.id}(picked=${String(r.picked)} hash=${String(r.hash)})`)
                .join(', ')}`
            : distinctHashes.size !== STAGE_IDS.length
            ? `only ${distinctHashes.size} distinct arenas across ${STAGE_IDS.length} stages — two stages drew the same, one is unwired: ${stageReadings
                .map((r) => `${r.id}:${String(r.hash)}`)
                .join(' ')}`
            : belowInk.length > 0
            ? `below the 2% ink floor: ${belowInk.map((r) => `${r.id}:${(r.ink * 100).toFixed(1)}%`).join(', ')}`
            : `${STAGE_IDS.length} stages, ${distinctHashes.size} distinct arenas, all above the ink floor`,
        );
      }

      // --- C5 screenshots-captured ------------------------------------------
      // Navigate, then scroll: a surface lives on a screen now, and a capture
      // that only scrolled would photograph whichever screen was showing.
      for (const surface of SURFACES) {
        await goto(surface.route);
        const present = await cdp.evaluate(scrollSurfaceIntoView(surface.selector));
        await sleep(250);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = join(shotDir, `${viewport.name}-${surface.id}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        if (!present) {
          record(`surface-present-${surface.id}-${viewport.name}`, false, `${surface.selector} is not on the page`);
        }
      }

      // --- C7 selected-fighter-is-drawn (Story 12.5) ------------------------
      //
      // The check the story exists for, and it runs LAST in the viewport pass,
      // after the captures. A roster that renders four cards and reaches
      // nothing passes `character-select-reachable` completely -- that check
      // reads text on a screen, and text on a screen is exactly what two
      // unreachable fighters already had for three epics.
      //
      // So: play one Match as gemini and one as grokk, from a fresh page each
      // time, and compare the two arenas. Both are the same seed at the same
      // Decision Point -- the arcade Match hangs waiting for the visitor -- so
      // the fighters stand in identical positions and the only thing that can
      // move a pixel is which sprites were drawn.
      //
      // Three conditions, and the second and third are what an independent
      // review of this story added:
      //
      //  1. The picked side's half of the arena differs between the two runs.
      //  2. The *other* half does not. A pick on side 0 that dressed side 1
      //     changes the picture just as much as correct wiring does, and one
      //     whole-arena hash cannot tell the two apart.
      //  3. Both runs carry real sprite ink. `CANVAS_PROBE`'s ratio cannot
      //     fail here -- the backdrop fills the frame and reports ~98% with no
      //     fighters drawn at all -- so the floor is counted in sprite ink.
      //
      // Sampled below the HUD band for Story 12.2's reason: the tick readout
      // and the bars advance on their own, and a hash that included them would
      // differ between two runs of the *same* fighter.
      //
      // Last in the pass, and not before the captures, because it leaves the
      // page on a chosen fighter: run earlier, every committed screenshot would
      // show grokk rather than what a first-time visitor meets.
      if (!viewport.mobile) {
        const asFighter = [];
        for (const id of ['gemini', 'grokk']) {
          await load(`${viewport.name}-as-${id}`, '/select');
          // The same wait the captures take: the packs are upgrades to an
          // already-running page, and a probe fired before they land measures
          // the block artist, which is identical for both fighters.
          await sleep(2500);
          const picked = await cdp.evaluate(pickFighter(0, id));
          // The pick starts the fetch; this is the decode.
          await sleep(2000);
          await goto('/play');
          const started = await cdp.evaluate(clickIn('#arcade', '^play vs cpu$'));
          await sleep(2000);
          const arena = await cdp.evaluate(arenaHalvesProbe('#arcade'));
          asFighter.push({
            id,
            // `aria-pressed` asserted, not merely reported: "a card exists and
            // was clicked" is true of a card wired to nothing.
            picked: picked.ok === true && picked.pressed === 'true',
            started: started.ok === true,
            arena,
          });
        }
        const [first, second] = asFighter;
        const measured = asFighter.every(
          (run) => run.picked && run.started && run.arena !== null,
        );
        record(
          'selected-fighter-is-drawn',
          measured &&
            asFighter.every((run) => run.arena.ink >= MIN_FIGHT_INK) &&
            first.arena.left !== second.arena.left &&
            first.arena.right === second.arena.right,
          asFighter
            .map(
              (run) =>
                `${run.id}: picked=${String(run.picked)} played=${String(run.started)} left=${String(run.arena?.left)} right=${String(run.arena?.right)} spriteInk=${String(run.arena?.ink)}`,
            )
            .join(' | ') +
            (measured && first.arena.right !== second.arena.right
              ? ' — the UNPICKED side moved too, so the pick did not reach the side that made it'
              : ''),
        );
      }
    }

    // --- C6 console-clean ----------------------------------------------------
    record(
      'console-clean',
      consoleFindings.length === 0,
      consoleFindings.length === 0 ? 'no errors or warnings' : consoleFindings.slice(0, 5).join(' | '),
    );
  } catch (error) {
    // A harness that could not finish is a failure, never a quiet pass.
    record('gate-harness', false, error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.close();
    killTree(chrome);
    killTree(vite);
    if (profileDir !== undefined) {
      // Best effort: Chrome may still be releasing the profile as we exit.
      await sleep(300);
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // --- verdict --------------------------------------------------------------
  let waivers = {};
  try {
    const parsed = JSON.parse(await readFile(WAIVERS_PATH, 'utf8'));
    // `_`-prefixed keys are prose for the reader (the file explains its own
    // ratchet at the top). Stripping them here rather than tolerating them
    // downstream keeps "every key is a check id" true everywhere else.
    waivers = Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith('_')));
  } catch {
    // No waiver file means no waivers, which is the state this file is aiming at.
  }

  const failed = checks.filter((c) => !c.ok);
  const fatal = failed.filter((c) => waivers[c.id] === undefined);
  const waived = failed.filter((c) => waivers[c.id] !== undefined);
  const staleWaivers = Object.keys(waivers).filter((id) => checks.some((c) => c.id === id && c.ok));

  await writeFile(
    join(shotDir, 'report.json'),
    `${JSON.stringify({ label, ranAt: new Date().toISOString(), checks, waived: waived.map((c) => c.id), staleWaivers }, null, 2)}\n`,
  );

  process.stdout.write(`\nScreenshots and report: docs/visual/${label}/\n`);

  for (const check of waived) {
    process.stdout.write(`  waived: ${check.id} — owed by ${waivers[check.id].story}\n`);
  }
  for (const id of staleWaivers) {
    process.stdout.write(`  STALE WAIVER: ${id} now passes. Delete its entry from docs/visual/known-failures.json.\n`);
  }

  if (fatal.length > 0 || staleWaivers.length > 0) {
    process.stdout.write(`\nVisual gate FAILED: ${fatal.length} unwaived failure(s), ${staleWaivers.length} stale waiver(s).\n`);
    process.exit(1);
  }

  process.stdout.write(`\nVisual gate passed (${waived.length} waived).\n`);
}

await main();
