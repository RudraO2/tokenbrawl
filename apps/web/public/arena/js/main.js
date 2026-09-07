// js/main.js  -  boot + main loop glue. Fixed-timestep loop, input gathering
// (keyboard/touch/gamepad -> the pinned bitmask), letterboxed canvas, pause-on-blur
// (offline modes only), ?dev=1 FPS overlay.

import { app } from './screens.js';
import { audio } from './audio.js';
import { t } from '../strings.js';
import { feel, vfx } from './vfx.js';
import { stageRt } from './stages.js';

// v2.1: input bitmask v3 - bit6 renamed SPECIAL -> BLAST (same value, circle button),
// bit9/512 = DASH (cross button). All masks now widen to & 0x3FF.
const BIT = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, LIGHT: 16, HEAVY: 32, BLAST: 64, START: 128, POWER: 256, DASH: 512 };
const MASK_ALL = 0x3FF;

const VW = 1920, VH = 1080;
const STEP_MS = 1000 / 60;
const DPR_CAP = 1.5;
const MAX_STEPS_PER_FRAME = 5;
const DECK_RATIO = 0.38; // portrait "Game Boy" bottom control deck height, fraction of viewport
const LANDSCAPE_TOAST_KEY = 'ngarena.landscapeToastSeen';

const params = new URLSearchParams(location.search);
const devMode = params.get('dev') === '1';
if (devMode) window.__ng = { app };

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

// ---------------------------------------------------------------------------
// letterboxed resize
// ---------------------------------------------------------------------------
let scale = 1, offX = 0, offY = 0;

// -----------------------------------------------------------------------------
// landscape suggestion toast - dismissible, shown once ever (localStorage flag).
// Replaces the old blocking rotate-device overlay: portrait is now fully playable
// (the "Game Boy" control deck below), this is just a gentle one-time nudge.
// -----------------------------------------------------------------------------
const landscapeToast = document.getElementById('ng-landscape-toast');
const landscapeToastText = document.getElementById('ng-landscape-toast-text');
const landscapeToastClose = document.getElementById('ng-landscape-toast-close');
if (landscapeToastText) landscapeToastText.textContent = t('toast_landscape');
if (landscapeToastClose) landscapeToastClose.textContent = t('toast_dismiss');
let landscapeToastShownThisSession = false;
let landscapeToastAutoHideTimer = null;
function dismissLandscapeToast() {
  if (landscapeToast) landscapeToast.style.display = 'none';
  if (landscapeToastAutoHideTimer) { clearTimeout(landscapeToastAutoHideTimer); landscapeToastAutoHideTimer = null; }
  try { localStorage.setItem(LANDSCAPE_TOAST_KEY, '1'); } catch (_e) { /* ignore */ }
}
if (landscapeToastClose) landscapeToastClose.addEventListener('click', dismissLandscapeToast);
function maybeShowLandscapeToast(portraitDeck) {
  if (!landscapeToast || !portraitDeck || landscapeToastShownThisSession) return;
  let seen = false;
  try { seen = localStorage.getItem(LANDSCAPE_TOAST_KEY) === '1'; } catch (_e) { /* ignore */ }
  if (seen) return;
  landscapeToastShownThisSession = true;
  landscapeToast.style.display = 'flex';
  landscapeToastAutoHideTimer = setTimeout(dismissLandscapeToast, 6000);
}

// -----------------------------------------------------------------------------
// resize: letterboxes the virtual 1920x1080 world into the canvas. In portrait
// "Game Boy" mode (touch-capable + portrait orientation) the canvas is shrunk to
// the TOP (1 - DECK_RATIO) of the viewport; the bottom control deck (CSS, driven
// by the body.portrait-deck class) owns the rest. Landscape keeps the canvas
// full-screen with the transparent overlay controls (v1 behaviour).
// -----------------------------------------------------------------------------
function detectPortraitDeck() {
  const portrait = window.innerHeight > window.innerWidth;
  let coarse = false;
  try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (_e) { /* ignore */ }
  const narrow = Math.min(window.innerWidth, window.innerHeight) <= 900;
  return portrait && (coarse || narrow);
}

function resize() {
  const portraitDeck = detectPortraitDeck();
  document.body.classList.toggle('portrait-deck', portraitDeck);

  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const w = window.innerWidth;
  const h = portraitDeck ? Math.max(1, Math.round(window.innerHeight * (1 - DECK_RATIO))) : window.innerHeight;

  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));

  scale = Math.min(canvas.width / VW, canvas.height / VH);
  offX = (canvas.width - VW * scale) / 2;
  offY = (canvas.height - VH * scale) / 2;

  maybeShowLandscapeToast(portraitDeck);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 50));
resize();

// ---------------------------------------------------------------------------
// audio: unlock on first user gesture (mobile autoplay policy)
// ---------------------------------------------------------------------------
let audioInited = false;
function initAudioOnce() {
  if (audioInited) return;
  audioInited = true;
  audio.init();
}
window.addEventListener('keydown', initAudioOnce, { once: true });
window.addEventListener('pointerdown', initAudioOnce, { once: true });

// ---------------------------------------------------------------------------
// keyboard input
// ---------------------------------------------------------------------------
const keys = new Set();
// Press latch: a key tapped faster than one 60Hz sim tick would vanish from
// `keys` before the next gatherInputs() sample and the edge would be lost.
// Every keydown also lands in `latched`, which is only cleared after a sim
// tick has consumed it - so even sub-frame taps register for exactly one tick.
const latched = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  latched.add(e.code);
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); latched.clear(); });

const down = (code) => keys.has(code) || latched.has(code);
// v2.1 PS scheme, P1: F=square(LIGHT) G=triangle(HEAVY) H=circle(BLAST) J=power
// K=dash L=ultimate (emits LIGHT|HEAVY|BLAST together - the ultimate INTENT per
// contracts.md; core only actually triggers the cinematic at meter 100) W=jump.
function p1KeyBits() {
  let m = 0;
  if (down('KeyA')) m |= BIT.LEFT;
  if (down('KeyD')) m |= BIT.RIGHT;
  if (down('KeyW')) m |= BIT.UP;
  if (down('KeyS')) m |= BIT.DOWN;
  if (down('KeyF')) m |= BIT.LIGHT;
  if (down('KeyG')) m |= BIT.HEAVY;
  if (down('KeyH')) m |= BIT.BLAST;
  if (down('KeyJ')) m |= BIT.POWER;
  if (down('KeyK')) m |= BIT.DASH;
  if (down('KeyL')) m |= (BIT.LIGHT | BIT.HEAVY | BIT.BLAST);
  if (down('Enter') || down('Space')) m |= BIT.START;
  return m;
}
// P2 (local): Digit1=square 2=triangle 3=circle(blast) 4=power 5=dash 6=ultimate,
// ArrowUp=jump.
function p2KeyBits() {
  let m = 0;
  if (down('ArrowLeft')) m |= BIT.LEFT;
  if (down('ArrowRight')) m |= BIT.RIGHT;
  if (down('ArrowUp')) m |= BIT.UP;
  if (down('ArrowDown')) m |= BIT.DOWN;
  if (down('Digit1')) m |= BIT.LIGHT;
  if (down('Digit2')) m |= BIT.HEAVY;
  if (down('Digit3')) m |= BIT.BLAST;
  if (down('Digit4')) m |= BIT.POWER;
  if (down('Digit5')) m |= BIT.DASH;
  if (down('Digit6')) m |= (BIT.LIGHT | BIT.HEAVY | BIT.BLAST);
  if (down('Enter') || down('Space')) m |= BIT.START;
  return m;
}

// ---------------------------------------------------------------------------
// touch controls (v2.1: PS diamond - square/triangle/circle/cross - + power/
// jump/ultimate; the ULTIMATE button is a multi-bit combo emitting
// LIGHT+HEAVY+BLAST together, shown by screens.js only at full meter).
// Pointer Events give correct independent multi-touch per button.
// ---------------------------------------------------------------------------
let touchMask = 0;
let touchLatch = 0; // same press-latch idea as `latched`, for sub-frame touch taps
let tapPulse = false;

function wireTouchButton(el) {
  if (!el) return;
  let bit = 0;
  if (el.dataset.bit) {
    bit = BIT[el.dataset.bit] || 0;
  } else if (el.dataset.combo) {
    bit = el.dataset.combo.split(',').reduce((acc, name) => acc | (BIT[name.trim()] || 0), 0);
  }
  if (!bit) return;

  const on = (e) => {
    e.preventDefault();
    touchMask |= bit;
    touchLatch |= bit;
    try { el.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    initAudioOnce();
  };
  const off = (e) => {
    e.preventDefault();
    touchMask &= ~bit;
  };
  el.addEventListener('pointerdown', on, { passive: false });
  el.addEventListener('pointerup', off, { passive: false });
  el.addEventListener('pointercancel', off, { passive: false });
  el.addEventListener('pointerleave', off, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
document.querySelectorAll('.touch-controls [data-bit], .touch-controls [data-combo]').forEach(wireTouchButton);

canvas.addEventListener('pointerdown', () => { tapPulse = true; initAudioOnce(); }, { passive: true });

// ---------------------------------------------------------------------------
// v2.1: "?" tutorial button - toggles screens.js's in-fight how-to overlay
// (state.howOverlayOpen). screens.js owns pausing offline / not pausing online
// and shows/hides this DOM button per screen; this file only wires the tap.
// ---------------------------------------------------------------------------
const tutorialBtn = document.getElementById('ng-tutorial-btn');
if (tutorialBtn) {
  tutorialBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (app.state.screen === 'fight') app.state.howOverlayOpen = !app.state.howOverlayOpen;
    initAudioOnce();
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// v2: floating analog stick - replaces the virtual d-pad. pointerdown anywhere
// in the left-half stick zone plants the base at that point; dragging moves the
// knob (clamped to STICK_RADIUS); a deadzone of STICK_DEADZONE maps dx -> LEFT/
// RIGHT and dy>deadzone -> DOWN. UP is NEVER emitted by the stick (JUMP is its
// own button). A single tracked pointerId supports simultaneous multi-touch
// with the independent button cluster (separate elements/listeners).
// ---------------------------------------------------------------------------
const STICK_RADIUS = 70;
const STICK_DEADZONE = 18;
const stickZone = document.getElementById('ng-stick-zone');
const stickBase = document.getElementById('ng-stick-base');
const stickKnob = document.getElementById('ng-stick-knob');
let stickPointerId = null;
let stickOriginX = 0, stickOriginY = 0;
let stickBits = 0;

function stickSetKnob(x, y) {
  if (stickKnob) { stickKnob.style.left = x + 'px'; stickKnob.style.top = y + 'px'; }
}
function stickShow(x, y) {
  if (stickBase) { stickBase.style.left = x + 'px'; stickBase.style.top = y + 'px'; stickBase.style.display = 'block'; }
  if (stickKnob) stickKnob.style.display = 'block';
  stickSetKnob(x, y);
}
function stickHide() {
  if (stickBase) stickBase.style.display = 'none';
  if (stickKnob) stickKnob.style.display = 'none';
  stickBits = 0;
}
function stickMove(x, y) {
  let dx = x - stickOriginX;
  let dy = y - stickOriginY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > STICK_RADIUS) {
    const k = STICK_RADIUS / dist;
    dx *= k; dy *= k;
  }
  stickSetKnob(stickOriginX + dx, stickOriginY + dy);
  let m = 0;
  if (dx > STICK_DEADZONE) m |= BIT.RIGHT;
  else if (dx < -STICK_DEADZONE) m |= BIT.LEFT;
  if (dy > STICK_DEADZONE) m |= BIT.DOWN; // NEVER emits UP - JUMP is a dedicated button
  stickBits = m;
}
if (stickZone) {
  stickZone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (stickPointerId !== null) return; // one active stick touch at a time
    stickPointerId = e.pointerId;
    stickOriginX = e.clientX;
    stickOriginY = e.clientY;
    stickBits = 0;
    stickShow(stickOriginX, stickOriginY);
    try { stickZone.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    initAudioOnce();
  }, { passive: false });
  stickZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointerId) return;
    e.preventDefault();
    stickMove(e.clientX, e.clientY);
  }, { passive: false });
  const stickEnd = (e) => {
    if (e.pointerId !== stickPointerId) return;
    e.preventDefault();
    stickPointerId = null;
    stickHide();
  };
  stickZone.addEventListener('pointerup', stickEnd, { passive: false });
  stickZone.addEventListener('pointercancel', stickEnd, { passive: false });
  stickZone.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// gamepad polling - v2.1 PS-style standard mapping: dpad/left-stick move,
// X=square/LIGHT(2), Y=triangle/HEAVY(3), B=circle/BLAST(1), A=cross/DASH(0),
// R1=ultimate combo(5), L1(4) or L2(6)=POWER, Start(9).
// ---------------------------------------------------------------------------
function gamepadBits(index) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads[index];
  if (!gp) return 0;
  let m = 0;
  const ax0 = gp.axes[0] || 0, ax1 = gp.axes[1] || 0;
  if ((gp.buttons[14] && gp.buttons[14].pressed) || ax0 < -0.3) m |= BIT.LEFT;
  if ((gp.buttons[15] && gp.buttons[15].pressed) || ax0 > 0.3) m |= BIT.RIGHT;
  if ((gp.buttons[12] && gp.buttons[12].pressed) || ax1 < -0.3) m |= BIT.UP;
  if ((gp.buttons[13] && gp.buttons[13].pressed) || ax1 > 0.3) m |= BIT.DOWN;
  if (gp.buttons[2] && gp.buttons[2].pressed) m |= BIT.LIGHT;
  if (gp.buttons[3] && gp.buttons[3].pressed) m |= BIT.HEAVY;
  if (gp.buttons[1] && gp.buttons[1].pressed) m |= BIT.BLAST;
  if (gp.buttons[0] && gp.buttons[0].pressed) m |= BIT.DASH;
  if (gp.buttons[5] && gp.buttons[5].pressed) m |= (BIT.LIGHT | BIT.HEAVY | BIT.BLAST);
  if ((gp.buttons[4] && gp.buttons[4].pressed) || (gp.buttons[6] && gp.buttons[6].pressed)) m |= BIT.POWER;
  if (gp.buttons[9] && gp.buttons[9].pressed) m |= BIT.START;
  return m;
}

function gatherInputs() {
  const startPulse = tapPulse ? BIT.START : 0;
  tapPulse = false;
  const local = (p1KeyBits() | gamepadBits(0) | touchMask | touchLatch | stickBits | startPulse) & MASK_ALL;
  const p2local = (p2KeyBits() | gamepadBits(1)) & MASK_ALL;
  // Latches consumed by this sample; live holds remain via keys/touchMask.
  latched.clear();
  touchLatch = 0;
  return { local, p2local };
}

// ---------------------------------------------------------------------------
// pause on blur  -  offline modes only; online netplay keeps stepping.
// The pause overlay/menu itself is state.paused, owned entirely by screens.js;
// we just flip the flag here so blur reuses the same in-game pause UI.
// ---------------------------------------------------------------------------
window.addEventListener('blur', () => {
  const st = app.state;
  const onlineActive = st.mode === 'online' && st.screen === 'fight';
  if (!onlineActive && st.screen === 'fight') st.paused = true;
});

// ---------------------------------------------------------------------------
// fixed-timestep loop
// ---------------------------------------------------------------------------
let acc = 0;
let last = performance.now();
const fpsSamples = [];
let fpsDisplay = 0;

function tick() {
  const { local, p2local } = gatherInputs();
  app.update({ local, p2local, dev: devMode });
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, offX, offY);
  ctx.imageSmoothingEnabled = false;
  app.draw(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (devMode) drawDevOverlay();
}

function drawDevOverlay() {
  ctx.font = '12px monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(4, 4, 190, 20);
  ctx.fillStyle = '#16C7E4';
  ctx.fillText('FPS ' + fpsDisplay.toFixed(1) + '  ' + app.state.screen, 8, 18);
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250; // clamp huge gaps (tab switch, debugger pause, etc.)

  fpsSamples.push(1000 / Math.max(dt, 1));
  if (fpsSamples.length > 30) fpsSamples.shift();
  fpsDisplay = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

  // feel/vfx/stage presentation timers advance once per RENDERED frame (per vfx.js's
  // pinned contract) - hitstop/slowmo must keep counting down in real time even while
  // they are freezing/slowing the fixed-tick sim below, or hitstop would never expire.
  feel.update();
  vfx.update();
  stageRt.update();

  acc += dt * feel.timeScale();
  let steps = 0;
  while (acc >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
    tick();
    acc -= STEP_MS;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) acc = 0; // avoid spiral of death

  render();
}

// ---------------------------------------------------------------------------
// hidden-tab ticker - ONLINE matches only. Chromium pauses rAF for hidden
// pages; in delay-based lockstep a backgrounded player would stop sending
// input frames and freeze their OPPONENT's game. While the page is hidden
// during an online fight, keep the fixed-step sim (and its input sends)
// running on a coarse interval; rendering stays paused (rAF owns that).
// ---------------------------------------------------------------------------
let hiddenTicker = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (hiddenTicker) return;
    hiddenTicker = setInterval(() => {
      const st = app.state;
      if (!(st.mode === 'online' && (st.screen === 'fight' || st.screen === 'vs'))) return;
      feel.update();
      acc += 50 * feel.timeScale();
      let steps = 0;
      while (acc >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
        tick();
        acc -= STEP_MS;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
      last = performance.now(); // keep rAF dt sane on return
    }, 50);
  } else {
    if (hiddenTicker) { clearInterval(hiddenTicker); hiddenTicker = null; }
    last = performance.now();
  }
});

app.go('boot');
requestAnimationFrame(frame);
