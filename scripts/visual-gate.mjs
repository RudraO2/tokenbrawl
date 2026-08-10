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
 */
const SURFACES = [
  { id: 'app', selector: '#app', label: 'replay player' },
  { id: 'arcade', selector: '#arcade', label: 'play vs cpu' },
  { id: 'spectate', selector: '#spectate', label: 'spectate stream' },
];

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

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
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

const scrollIntoView = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  return true;
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
        // Determinism, not cosmetics: a CI host with reduced motion enabled
        // would put the player on its still-frame path and every animation
        // check below would fail for a reason that has nothing to do with the
        // change under test.
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

    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });
      // Navigate and wait for the load event rather than navigating and
      // reloading: a `Page.reload` issued while the navigation it follows is
      // still in flight detaches the session out from under the next call.
      const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${sitePort}/` });
      await Promise.race([loaded, sleep(15_000)]);

      // The asset upgrades are deliberately off the critical path (see
      // `startup.ts`): sprites and the backdrop swap into an already-running
      // fight. A capture taken on load correctly shows the block artist and
      // proves nothing, so the wait is part of the measurement.
      await sleep(2500);

      // --- C1 arcade-live-canvas -------------------------------------------
      // The mode a visitor is most likely to try first. Today the Match runs
      // headlessly and there is no canvas in `#arcade` at all.
      if (!viewport.mobile) {
        const started = await cdp.evaluate(clickIn('#arcade', '^play vs cpu$'));
        await sleep(1200);
        const arcade = await cdp.evaluate(hostCanvasProbe('#arcade'));
        record(
          'arcade-live-canvas',
          started.ok === true && arcade.visible > 0,
          `started=${String(started.ok)} canvases=${arcade.canvases} visible=${arcade.visible}`,
        );
      }

      // --- C2 no-horizontal-overflow ---------------------------------------
      const overflow = await cdp.evaluate(OVERFLOW_PROBE);
      if (viewport.mobile) {
        const offenders = overflow.offenders.map((o) => `${o.tag}.${o.cls || '-'}@${o.right}px`).join(', ');
        record(
          'no-horizontal-overflow',
          overflow.scrollWidth <= overflow.clientWidth + 1,
          `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}${offenders ? ` widest: ${offenders}` : ''}`,
        );
      }

      // --- C3 canvas-not-blank ----------------------------------------------
      const canvases = await cdp.evaluate(CANVAS_PROBE);
      const blank = canvases.filter((c) => c.visible && c.readable && c.inkRatio < MIN_INK_RATIO);
      record(
        `canvas-not-blank-${viewport.name}`,
        canvases.length > 0 && blank.length === 0,
        canvases.length === 0
          ? 'no canvas on the page at all'
          : `${canvases.length} canvas(es), ink ${canvases.map((c) => `${c.host ?? '?'}:${(c.inkRatio * 100).toFixed(1)}%`).join(' ')}`,
      );

      // --- C4 spectate-animates ---------------------------------------------
      // The Story 11-6 defect exactly: a surface holding one still frame while
      // every unit test about it stayed green.
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

      // --- C5 screenshots-captured ------------------------------------------
      for (const surface of SURFACES) {
        const present = await cdp.evaluate(scrollIntoView(surface.selector));
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
