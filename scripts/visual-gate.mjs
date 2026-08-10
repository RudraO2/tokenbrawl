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
 * `renderer.ts`'s `HUD_BOTTOM` is 118; 130 leaves margin under it. The
 * fighter-movement check below hashes *below* this line and nothing above it,
 * which is the difference between a check that measures the fight and one that
 * measures the clock: `TICK NNN` and the health/meter bars change every Decision
 * Point on their own, so a whole-canvas hash goes green on a canvas whose
 * fighters are frozen, drawn as blocks, or drawn off-stage. Excluding the band
 * makes the check fail if the *fighters* stop moving, which is what it is for.
 */
const ARENA_TOP_PX = 130;

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

        // --- C4d selected-fighter-is-drawn (Story 12.5) --------------------
        //
        // The check the story exists for. A roster that renders four cards and
        // reaches nothing would pass `character-select-reachable` completely --
        // that check reads text on a screen, and text on a screen is exactly
        // what two unreachable fighters already had.
        //
        // So: play one Match as gemini and one as grokk, from a fresh page each
        // time, and require the two arena pictures to differ while both clear
        // the ink floor. Both Matches are the same seed at the same Decision
        // Point (the arcade Match hangs waiting for the visitor), so the
        // fighters stand in identical positions and the *only* thing that can
        // move the hash is which sprites were drawn. Two identical pictures
        // mean the selection reached nothing; a blank one means it reached the
        // loader and the loader failed.
        //
        // Hashed below the HUD band for Story 12.2's reason: `TICK NNN` and the
        // bars advance on their own, so a whole-canvas hash would differ
        // between two runs of the *same* fighter and this check would pass on a
        // selection that did nothing at all.
        const asFighter = [];
        for (const id of ['gemini', 'grokk']) {
          await load(`${viewport.name}-as-${id}`, '/select');
          // Same wait the captures take: the packs are upgrades to an already
          // running page and a probe fired before they land measures the block
          // artist, which is identical for both fighters.
          await sleep(2500);
          const picked = await cdp.evaluate(pickFighter(0, id));
          // The pick starts the fetch; this is the decode.
          await sleep(2000);
          await goto('/play');
          const started = await cdp.evaluate(clickIn('#arcade', '^play vs cpu$'));
          await sleep(2000);
          const canvas = (await cdp.evaluate(CANVAS_PROBE)).find(
            (c) => c.host === 'arcade' && c.visible,
          );
          asFighter.push({
            id,
            picked: picked.ok === true,
            started: started.ok === true,
            hash: await cdp.evaluate(hostArenaHashProbe('#arcade')),
            ink: canvas?.inkRatio ?? 0,
          });
        }
        const [first, second] = asFighter;
        record(
          'selected-fighter-is-drawn',
          asFighter.every((run) => run.picked && run.started && run.hash !== null) &&
            asFighter.every((run) => run.ink >= MIN_INK_RATIO) &&
            first.hash !== second.hash,
          asFighter
            .map(
              (run) =>
                `${run.id}: picked=${String(run.picked)} played=${String(run.started)} arena=${String(run.hash)} ink=${(run.ink * 100).toFixed(1)}%`,
            )
            .join(' | '),
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
