// js/screens.js  -  screen state machine + all screens (contracts.md: export const app).
// Consumes core.js / data.js / net.js / atlas.js / vfx.js / stages.js ONLY via their pinned
// exports. Those files may not exist on disk yet at authoring time  -  that's expected; this
// module never stubs or creates them, it just imports the pinned names.

import { t } from '../strings.js';
import { audio } from './audio.js';
import { FP, createMatch, stepMatch, hashState, serialize, deserialize, cpuInput } from './core.js';
import { FIGHTERS, STAGES } from './data.js';
import { connectRoom } from './net.js';
import { loadAtlas, drawPose } from './atlas.js';
import { vfx, feel } from './vfx.js';
import { stageRt } from './stages.js';
import { drawCapsuleFighter } from './placeholder.js';

// core.js stateName -> atlas pose name. core.js (final, on disk) uses a richer state set
// than the atlas pose list, so several states share a pose: thrown/hitstun -> hit,
// blockstun/parry -> block, slide -> kickL (low sliding attack), land -> idle.
const STATE_TO_POSE = {
  attackL: 'punchL', attackH: 'punchH', special: 'special1',
  hitstun: 'hit', thrown: 'hit',
  blockstun: 'block', parry: 'block',
  slide: 'kickL', land: 'idle',
  // v2.2 dashes use the supplemental 'dash_lunge' pose (falls back to 'walk' cells,
  // drawn at a higher fps in drawFighter, when the _x atlas is absent).
  dashF: 'dash_lunge', dashB: 'dash_lunge',
  // v2.4 air dash (WP1's new dashAirF/dashAirB states) reuses 'dash_lunge' too - MVP,
  // zero new art required. Full-art tier: if the _x atlas later gains dedicated
  // 'air_dashF'/'air_dashB' cells, point these at those names instead and add them to
  // SUPP_POSES + SUPP_FALLBACK (mapping to 'dash_lunge') below.
  dashAirF: 'dash_lunge', dashAirB: 'dash_lunge',
};
function poseNameFor(stateName) { return STATE_TO_POSE[stateName] || stateName || 'idle'; }

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const W = 1920, H = 1080;
// v2: bit8/256 = POWER (charge/transform). Masks widen to 0x1FF everywhere.
// v2.1: BLAST is the circle bit (same value as v2 SPECIAL); DASH is the cross bit.
const BIT = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, LIGHT: 16, HEAVY: 32, SPECIAL: 64, BLAST: 64, START: 128, POWER: 256, DASH: 512 };
const CYAN = '#16C7E4';
const DARK = '#0E0E10';
const CARD = '#161618';
const GOLD = '#FFD24A';
const ROSTER = ['clawde', 'chatty', 'gemini', 'grokk', 'pilot', 'seeker', 'lama', 'edison'];
const STAGE_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'];
const OPTS_KEY = 'ngarena.opts';
// Tokenbrawl embed: ?mode=duel puts the cabinet straight on character select, P1 picks
// their own fighter and then the CPU's, and every "quit to menu" lands back on select.
// The host page (parent frame) is the menu. Nothing here changes the fight itself.
const EMBED_PARAMS = new URLSearchParams(location.search);
const EMBED_DUEL = EMBED_PARAMS.get('mode') === 'duel';
function embedPost(type, data) {
  try { if (window.parent && window.parent !== window) window.parent.postMessage(Object.assign({ source: 'tb-arena', type }, data || {}), '*'); } catch (_e) { /* ignore */ }
}
function embedApplyOpts(o) {
  if (!EMBED_DUEL) return o;
  const cpu = parseInt(EMBED_PARAMS.get('cpu'), 10);
  const rounds = parseInt(EMBED_PARAMS.get('rounds'), 10);
  if (cpu >= 1 && cpu <= 3) o.cpuLevel = cpu;
  if (rounds === 1 || rounds === 3 || rounds === 5) o.rounds = rounds;
  return o;
}
const DEFAULT_OPTS = { rounds: 3, musicVol: 0.8, sfxVol: 1, cpuLevel: 2, shake: true, flash: true };
const OPT_ROWS = ['rounds', 'musicVol', 'sfxVol', 'cpuLevel', 'shake', 'flash', 'back'];
const MENU_ITEMS = [
  { key: 'arcade', label: 'menu_arcade' },
  { key: 'online', label: 'menu_vsonline' },
  { key: 'local', label: 'menu_localvs' },
  { key: 'practice', label: 'menu_practice' },
  { key: 'options', label: 'menu_options' },
  { key: 'how', label: 'menu_how' },
];
// v2.1 DYNAMIC CAMERA: a single reused object (never reallocated per frame). The
// vfx.js / stages.js floor plane map world->screen as
//   screen = worldCenter + (world - cam) * zoom   (worldCenter = W/2, H/2)
// so screens.js draws fighters/aura/projectiles wrapped in the SAME transform
// (applyCam) while stageRt.draw / vfx.draw apply cam themselves from the object.
const CAM = { x: W / 2, y: H / 2, zoom: 1 };
const CAM_MARGIN = 220;       // world px of breathing room each side of a fighter
const CAM_MIN_VIS_W = 850;    // tightest visible world width (most zoomed in)
const CAM_MAX_VIS_W = 1500;   // widest visible world width (most pulled back)
const CAM_FEET_FRAC = 0.86;   // fighters' feet sit at ~86% of the frame height
const CAM_LERP = 0.08;        // 8% per frame ease toward the target
const CAM_FLOOR_Y = 880;      // world floor line (contracts: floor y = 880*FP)
const CAM_AIR_THRESHOLD = 300;// px above floor before vertical follow kicks in
const CAM_AIR_MAX = 420;      // cap on the extra upward pan on a double jump
// Fighters draw from a stable 208px atlas cell at scale 1, bottom-anchored at fpToPx(f.y),
// with the character content filling only ~half the cell (drawn head-top ~100px above the
// feet). Combat effects anchor off this DRAWN cell, NOT the fighter's logical height, or
// they float above the drawn head. 0.30 = drawn chest, 0.40 = drawn upper-chest/shoulder.
const SPRITE_CELL_PX = 208;

// v2.1 PRACTICE dummy behaviors (drives practiceDummyInput) + pause-panel rows.
const DUMMY_BEHAVIORS = ['idle', 'block', 'crouch', 'jump', 'cpu1', 'cpu2', 'cpu3'];
const PRACTICE_ROWS = ['dummy', 'refillHp', 'refillKi', 'refillMeter', 'showCombolist', 'reset', 'resume', 'quit'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function edge(cur, prev, bit) { return (cur & bit) !== 0 && (prev & bit) === 0; }
function anyEdge(cur, prev) { return (cur & ~prev) !== 0; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, p) { return a + (b - a) * p; }
function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

const imgCache = new Map();
function img(src) {
  let im = imgCache.get(src);
  if (!im) {
    im = new Image();
    im._ok = false;
    im._failed = false;
    im.onload = () => { im._ok = true; };
    im.onerror = () => { im._failed = true; };
    im.src = src;
    imgCache.set(src, im);
  }
  return im;
}

function bg(ctx, color) {
  ctx.fillStyle = color || DARK;
  ctx.fillRect(0, 0, W, H);
}

function chunkyText(ctx, str, x, y, size, color, align, outline, maxW) {
  ctx.save();
  ctx.font = `900 ${size}px Arial, sans-serif`;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (outline !== null) {
    ctx.strokeStyle = outline || 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(2, size * 0.08);
    if (maxW) ctx.strokeText(str, x, y, maxW); else ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = color || '#fff';
  if (maxW) ctx.fillText(str, x, y, maxW); else ctx.fillText(str, x, y);
  ctx.restore();
}

function loadOpts() {
  try {
    const raw = localStorage.getItem(OPTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return Object.assign({}, DEFAULT_OPTS, parsed);
  } catch (e) { return Object.assign({}, DEFAULT_OPTS); }
}
function saveOpts(o) {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
}

function fpToPx(v) { return (v || 0) / FP; }

function hexToRgb(hex) {
  const h = (hex || '#16C7E4').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgba(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
// mix hex `b` into hex `a` by fraction t (t of b, 1-t of a) -> 'rgb(...)' string.
function mixHex(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

// ---------------------------------------------------------------------------
// v2: aura particle pool - OUR OWN pooled layer (separate from vfx.js's pool),
// used for the charge-state rising flame aura, the persistent post-transform
// aura, and the transform-completion burst. Zero per-frame allocations: fixed
// array of plain objects, reused forever. Hard cap (design/thresholds.md style
// budget requested by the brief: ~80 aura particles across both fighters).
// ---------------------------------------------------------------------------
const AURA_CAP = 80;
function makeAuraParticle() {
  return { active: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1, hex: '#FFFFFF', core: false, drift: 0 };
}
const AURA_POOL = new Array(AURA_CAP);
for (let i = 0; i < AURA_CAP; i++) AURA_POOL[i] = makeAuraParticle();
let auraCursor = 0;
function auraAcquire() {
  for (let i = 0; i < AURA_CAP; i++) {
    const idx = (auraCursor + i) % AURA_CAP;
    if (!AURA_POOL[idx].active) { auraCursor = (idx + 1) % AURA_CAP; return AURA_POOL[idx]; }
  }
  return null; // pool is a hard budget, not a suggestion - drop silently when full
}
// Deterministic-enough pseudo-variance for a presentation-only layer (this is NOT
// sim code - it never touches match state - so a plain running counter is fine,
// no seeded RNG required here).
let auraJitter = 0;
function auraRand() { auraJitter = (auraJitter + 2654435761) >>> 0; return (auraJitter % 1000) / 1000; }

function spawnAuraFlame(x, y, hex, big, scale) {
  const p = auraAcquire();
  if (!p) return;
  const sc = scale || 1; // v2.2: flame spread + tongue size track the fighter's height
  const spread = (big ? 70 : 34) * sc;
  p.active = true;
  p.x = x + (auraRand() - 0.5) * spread;
  p.y = y - auraRand() * (big ? 18 : 8);
  p.vx = (auraRand() - 0.5) * (big ? 0.5 : 0.25);
  p.vy = -(big ? 2.6 : 1.5) - auraRand() * (big ? 2.4 : 1.2);
  p.life = (big ? 34 : 22) + auraRand() * 14;
  p.age = 0;
  p.size = ((big ? 20 : 11) + auraRand() * (big ? 16 : 8)) * (0.7 + sc * 0.3);
  p.hex = hex;
  p.core = auraRand() < 0.35;
  p.drift = (auraRand() - 0.5) * 0.06;
  return p;
}
function spawnAuraBurst(x, y, hex, count) {
  for (let i = 0; i < count; i++) {
    const p = auraAcquire();
    if (!p) return;
    const ang = (i / count) * Math.PI * 2 + auraRand() * 0.6;
    const spd = 3 + auraRand() * 6;
    p.active = true;
    p.x = x; p.y = y - 40;
    p.vx = Math.cos(ang) * spd;
    p.vy = Math.sin(ang) * spd * 0.6 - 2;
    p.life = 24 + auraRand() * 16;
    p.age = 0;
    p.size = 10 + auraRand() * 14;
    p.hex = hex;
    p.core = auraRand() < 0.5;
    p.drift = (auraRand() - 0.5) * 0.1;
  }
}
function updateAuraParticles() {
  for (let i = 0; i < AURA_CAP; i++) {
    const p = AURA_POOL[i];
    if (!p.active) continue;
    p.age++;
    if (p.age >= p.life) { p.active = false; continue; }
    p.x += p.vx; p.y += p.vy;
    p.vx += p.drift;
    p.vy *= 0.985; // flame tongues decelerate as they rise/dissipate
  }
}
function drawAuraParticles(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < AURA_CAP; i++) {
    const p = AURA_POOL[i];
    if (!p.active) continue;
    const fade = 1 - p.age / p.life;
    const h = p.size * (0.5 + fade * 0.7);
    const w = h * 0.55;
    ctx.globalAlpha = Math.max(0, fade * (p.core ? 0.9 : 0.55));
    ctx.fillStyle = p.core ? '#FFF3B0' : p.hex;
    // teardrop flame tongue: a circle base tapering to a point above it
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - h);
    ctx.quadraticCurveTo(p.x + w, p.y - h * 0.35, p.x, p.y + h * 0.28);
    ctx.quadraticCurveTo(p.x - w, p.y - h * 0.35, p.x, p.y - h);
    ctx.fill();
  }
  ctx.restore();
}
function clearAuraParticles() { for (let i = 0; i < AURA_CAP; i++) AURA_POOL[i].active = false; }

// ---------------------------------------------------------------------------
// v2.4 ki-blast impact "boom": a tiny one-shot art-driven burst pool, drawn via
// the fx_blast atlas (blast_<fid>_impact1 -> impact2), presentation-only. Spawned
// from handleEvents on a genuine projectile 'hit' (never on a whiff - the
// projectile's own ttl despawn already handles that with no boom, see
// resolveProjectiles in core.js). When the atlas/pose is absent, spawnBlastImpact
// is simply never called and the existing spark_h/spark_l ember (already
// unconditional in the 'hit' handler) IS the fallback look - no separate
// fallback path needed here. Fixed pool, zero per-frame allocations.
// ---------------------------------------------------------------------------
const BLAST_IMPACT_CAP = 6;
function makeBlastImpact() { return { active: false, fid: '', x: 0, y: 0, flip: false, tt: 0, life: 16 }; }
const BLAST_IMPACT_POOL = new Array(BLAST_IMPACT_CAP);
for (let i = 0; i < BLAST_IMPACT_CAP; i++) BLAST_IMPACT_POOL[i] = makeBlastImpact();
let blastImpactCursor = 0;
function spawnBlastImpact(fid, x, y, flip) {
  for (let i = 0; i < BLAST_IMPACT_CAP; i++) {
    const idx = (blastImpactCursor + i) % BLAST_IMPACT_CAP;
    const p = BLAST_IMPACT_POOL[idx];
    if (!p.active) {
      blastImpactCursor = (idx + 1) % BLAST_IMPACT_CAP;
      p.active = true; p.fid = fid; p.x = x; p.y = y; p.flip = !!flip; p.tt = 0; p.life = 16;
      return;
    }
  }
  // pool full (hard budget, not a suggestion): drop silently, same spirit as the vfx pool.
}
function updateBlastImpacts() {
  for (let i = 0; i < BLAST_IMPACT_CAP; i++) {
    const p = BLAST_IMPACT_POOL[i];
    if (!p.active) continue;
    p.tt++;
    if (p.tt >= p.life) p.active = false;
  }
}
function drawBlastImpacts(ctx) {
  const blast = state.fxBlast;
  if (!blast) return; // no atlas loaded/present: nothing extra to draw (spark fallback already fired)
  for (let i = 0; i < BLAST_IMPACT_CAP; i++) {
    const p = BLAST_IMPACT_POOL[i];
    if (!p.active) continue;
    const poseName = 'blast_' + p.fid + (p.tt < p.life / 2 ? '_impact1' : '_impact2');
    if (!atlasHasPose(blast, poseName)) continue; // graceful per-pose fallback: just skip
    const scale = 1.3;
    const dh = blast.cell.h * scale;
    // NORMAL compositing (source-over) so the baked FIGHTER-COLOUR burst reads instead of
    // additively stacking its bright core to pure white. Gentle late-life alpha fade so the
    // burst dissipates smoothly on top of the impact1 -> impact2 pose swap.
    const a = p.tt > p.life * 0.6 ? Math.max(0, 1 - (p.tt - p.life * 0.6) / (p.life * 0.4)) : 1;
    drawPose(ctx, blast, poseName, p.tt, p.x, p.y + dh / 2, { flip: p.flip, scale, alpha: a });
  }
}
function clearBlastImpacts() { for (let i = 0; i < BLAST_IMPACT_CAP; i++) BLAST_IMPACT_POOL[i].active = false; }

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  screen: 'boot',
  t: 0,
  prevLocal: 0, prevP2local: 0,
  opts: embedApplyOpts(loadOpts()),

  mode: null,
  arcadeLadder: [], arcadeIndex: 0,
  p1Fighter: null, p2Fighter: null,

  selCursorP1: 0, selCursorP2: 1,
  selConfirmedP1: false, selConfirmedP2: false,

  stageCursor: 0, stageConfirmed: false, stageId: null,

  match: null,
  atlases: {},
  matchEndPending: null,
  perfectThisRound: false,

  roundSplash: null,
  roundEndSplash: null,
  comboPop: [0, 0],
  prevCombo: [0, 0],

  // ---- v2: transform/aura/ultimate presentation state (client-side only, never
  // fed into core - purely how we *draw* the core's authoritative form/ki/charging
  // fields). Indexed by side 0/1.
  prevStateName: [null, null],
  prevForm: [0, 0],
  transformPending: [false, false],
  transformDim: [0, 0],
  formSplash: null,
  kiFlashTt: [0, 0],
  cinematic: null,      // {side, tt, edison, fid, flashed}
  ultChallengeFx: null, // v2.5 reaction-window prompt: {respSide, max, tt}
  clashFx: null,        // v2.3 ultimate-clash cinematic: {tt, resolveTt, winner, cx, cy} (worldpx)
  beamWindow: [0, 0],   // ticks remaining to render this side's active projectile as a beam
  beamAnchor: [null, null], // {x,y,dir} worldpx captured at beam spawn - the sim beam despawns
                            // the SAME tick it hits (it spans the arena), so the render must not
                            // depend on the pool slot staying active (see drawBeamWindows)
  atlasNextTried: new Set(), // "id_fN" keys we've already kicked a prefetch for

  // ---- v2.2: supplemental combo-sheet atlases (id_fN_x), the unique-ultimate FX
  // atlas, and per-side KO landing-dust guards. fxUlt: undefined=untried,
  // null=loading, false=absent (procedural fallback), object=loaded.
  fxUlt: undefined,
  // ---- v2.4: per-fighter ki-blast FX atlas (assets/atlas/fx_blast.json), same
  // undefined/null/false/object lifecycle as fxUlt (see ensureFxBlastAtlas below).
  fxBlast: undefined,
  koDustDone: [false, false],
  // HUD redesign caches (built lazily in drawHud, rebuilt per fighter pairing):
  // Path2Ds + absolute gradients + the damage-lag ghost/timer-pop presentation state.
  hudCache: null,
  hudGhost: [1, 1],       // damage-lag ghost HP fraction per side (drains toward live hp)
  hudTimerPrev: -1,       // last whole-second shown (drives the timer scale-pop)
  hudTimerPop: 0,         // remaining pop ticks

  paused: false,
  pauseIndex: 0,
  optionsReturnScreen: 'menu',

  // ---- v2.1: dynamic-camera snap flag (skip the lerp on the first fight frame),
  // in-fight how-to overlay toggle (main.js "?" button flips it), and touch-DOM
  // cache so we only write #ng-btn-ultimate / #ng-tutorial-btn on a real change.
  camSnap: true,
  howOverlayOpen: false,
  domUltReady: false,
  domUltHex: '',
  domTutShown: false,

  // ---- v2.1: PRACTICE mode (offline trainer). practiceSettings persists across
  // resets; practiceStats is the trainer-HUD readout; practiceTimer0 is the frozen
  // timer value captured at match start.
  practiceSettings: { dummy: 'idle', refillHp: true, refillKi: false, refillMeter: true, showCombolist: true },
  practiceStats: { totalDmg: 0, lastDmg: 0, lastInput: 0 },
  practiceIndex: 0,
  practiceTimer0: 0,

  net: null,
  netSeat: 0,
  netStatus: 'idle',
  netSeed: 0,
  roomId: null,
  remoteInputs: new Map(),
  localScheduled: new Map(),
  localInputDelay: 3,
  hashSentAt: new Map(),
  hashMismatchStreak: 0,
  rematchVotes: { p1: false, p2: false },
  localVotedRematch: false,

  menuIndex: 0,
  optionsIndex: 0,
  resultIndex: 0,

  toast: null,
};

// ---------------------------------------------------------------------------
// screen transitions
// ---------------------------------------------------------------------------
function resetSelect() {
  state.selCursorP1 = 0;
  state.selCursorP2 = 1;
  state.selConfirmedP1 = false;
  state.selConfirmedP2 = false;
}
function resetStageSelect() {
  state.stageCursor = 0;
  state.stageConfirmed = false;
  state.stageId = state.stageId || null;
}

function go(screen, payload) {
  if (EMBED_DUEL && (screen === 'menu' || screen === 'title')) {
    screen = 'select';
    payload = Object.assign({}, payload || {}, { mode: 'duel' });
    if (state.net) closeNet();
  }
  state.screen = screen;
  state.t = 0;
  if (payload) Object.assign(state, payload);

  if (screen === 'title') {
    audio.music('music_title');
  } else if (screen === 'menu') {
    audio.music('music_title');
    state.menuIndex = 0;
    if (state.net) closeNet();
    state.mode = null;
  } else if (screen === 'select') {
    resetSelect();
    audio.vo('vo_choose');
  } else if (screen === 'stageSelect') {
    resetStageSelect();
  } else if (screen === 'vs') {
    // nothing extra; state.t drives the intro tween
  } else if (screen === 'fight') {
    startMatch();
  } else if (screen === 'result') {
    state.resultIndex = 0;
    state.rematchVotes = { p1: false, p2: false };
    state.localVotedRematch = false;
  } else if (screen === 'options') {
    state.optionsIndex = 0;
  }

  updateShareButton();
  embedPost('screen', { screen, mode: state.mode });
}

function updateShareButton() {
  const el = document.getElementById('ng-share');
  const copyEl = document.getElementById('ng-copy');
  // The HOST (seat 1) sees an invite panel while setting up online, so a friend can
  // join by link instead of copying the browser URL by hand.
  const lobby = state.mode === 'online' && state.netSeat === 1 &&
    (state.screen === 'select' || state.screen === 'stageSelect');
  if (el) {
    if (state.screen === 'result' && state.mode === 'online') {
      const msg = t('share_challenge') + ' ' + location.href;
      el.href = 'https://wa.me/?text=' + encodeURIComponent(msg);
      el.textContent = t('result_share_whatsapp');
      el.style.display = 'flex';
    } else if (lobby) {
      const msg = t('share_challenge') + ' ' + location.href;
      el.href = 'https://wa.me/?text=' + encodeURIComponent(msg);
      el.textContent = t('online_share_whatsapp');
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
    el.classList.toggle('ng-lobby', lobby);
  }
  if (copyEl) {
    copyEl.textContent = t('online_copy_link');
    copyEl.style.display = lobby ? 'flex' : 'none';
    copyEl.classList.toggle('ng-lobby', lobby);
  }
}

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
function updateBoot(cur) {
  if (EMBED_DUEL) {
    state.mode = 'duel';
    go('select', { mode: 'duel' });
    const pre = EMBED_PARAMS.get('p1');
    const at = ROSTER.indexOf(pre);
    if (at >= 0) state.selCursorP1 = at;
    return;
  }
  if (state.t > 120 || ((cur.local | cur.p2local) & (BIT.LIGHT | BIT.START))) go('title');
}
function drawBoot(ctx) {
  bg(ctx, DARK);
  const a = Math.min(1, state.t / 30);
  ctx.save();
  ctx.globalAlpha = a;
  chunkyText(ctx, t('boot_line3'), W / 2, H * 0.42, 60, CYAN);
  chunkyText(ctx, t('boot_line1'), W / 2, H * 0.54, 22, '#fff');
  chunkyText(ctx, t('boot_line2'), W / 2, H * 0.60, 22, 'rgba(255,255,255,0.7)');
  ctx.restore();
}

// ---------------------------------------------------------------------------
// TITLE  -  the key art already contains the logo/tagline/roster/"PRESS START";
// we only overlay a pulsing glow near its baked-in caption. Text fallback only
// if the image failed to load.
// ---------------------------------------------------------------------------
function updateTitle(cur) {
  if (anyEdge(cur.local, state.prevLocal) || anyEdge(cur.p2local, state.prevP2local)) {
    // Invite links carry ?room=<id>: the invitee jumps straight into the
    // online flow so a shared challenge link works in one tap.
    const invitedRoom = new URLSearchParams(location.search).get('room');
    if (invitedRoom && !state.net) {
      state.mode = 'online';
      connectNet();
      go('select', { mode: 'online' });
    } else {
      go('menu');
    }
  }
}
function drawTitle(ctx) {
  const im = img('./assets/ui/title.png');
  if (im._ok) {
    ctx.drawImage(im, 0, 0, W, H);
    const cx = W * 0.5, cy = H * 0.955;
    const gw = W * 0.24, gh = H * 0.07;
    const pulse = 0.35 + 0.35 * Math.abs(Math.sin(state.t / 34));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, gw * 0.6);
    grad.addColorStop(0, `rgba(255,210,60,${0.55 * pulse})`);
    grad.addColorStop(1, 'rgba(255,210,60,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - gw, cy - gh, gw * 2, gh * 2);
    ctx.fillStyle = `rgba(255,210,60,${0.5 + 0.5 * pulse})`;
    ctx.fillRect(cx - gw * 0.5, cy + gh * 0.55, gw, Math.max(2, H * 0.004));
    ctx.restore();
  } else if (im._failed) {
    bg(ctx, DARK);
    chunkyText(ctx, t('title_game_name'), W / 2, H * 0.4, 120, CYAN);
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(state.t / 24));
    ctx.save();
    ctx.globalAlpha = pulse;
    chunkyText(ctx, t('title_press_start'), W / 2, H * 0.64, 46, '#fff');
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = pulse * 0.8;
    chunkyText(ctx, t('title_tap_play'), W / 2, H * 0.72, 30, 'rgba(255,255,255,0.8)');
    ctx.restore();
  } else {
    bg(ctx, DARK);
  }
}

// ---------------------------------------------------------------------------
// MAIN MENU
// ---------------------------------------------------------------------------
function menuConfirm(index) {
  const key = MENU_ITEMS[index].key;
  if (key === 'arcade') { state.mode = 'arcade'; go('select', { mode: 'arcade' }); }
  else if (key === 'local') { state.mode = 'local'; go('select', { mode: 'local' }); }
  else if (key === 'practice') { state.mode = 'practice'; go('select', { mode: 'practice' }); }
  else if (key === 'online') { state.mode = 'online'; connectNet(); go('select', { mode: 'online' }); }
  else if (key === 'options') { state.optionsReturnScreen = 'menu'; go('options'); }
  else if (key === 'how') { go('how'); }
}
function updateMenu(cur) {
  if (edge(cur.local, state.prevLocal, BIT.UP)) state.menuIndex = (state.menuIndex + MENU_ITEMS.length - 1) % MENU_ITEMS.length;
  if (edge(cur.local, state.prevLocal, BIT.DOWN)) state.menuIndex = (state.menuIndex + 1) % MENU_ITEMS.length;
  if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) menuConfirm(state.menuIndex);
}
function drawMenu(ctx) {
  bg(ctx, DARK);
  // dimmed key art keeps the arcade mood behind the menu list
  const im = img('./assets/ui/title.png');
  if (im._ok) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.drawImage(im, 0, 0, W, H);
    ctx.restore();
    ctx.fillStyle = 'rgba(10,12,18,0.55)';
    ctx.fillRect(0, 0, W, H);
  }
  chunkyText(ctx, t('menu_title'), W / 2, H * 0.2, 70, CYAN);
  MENU_ITEMS.forEach((item, i) => {
    const y = H * 0.4 + i * 90;
    const active = state.menuIndex === i;
    const w = 620, h = 68;
    ctx.fillStyle = active ? 'rgba(22,199,228,0.16)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(W / 2 - w / 2, y - h / 2, w, h);
    ctx.strokeStyle = active ? CYAN : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = active ? 3 : 1;
    ctx.strokeRect(W / 2 - w / 2, y - h / 2, w, h);
    chunkyText(ctx, t(item.label), W / 2, y, 34, active ? CYAN : '#fff');
  });
}

// ---------------------------------------------------------------------------
// CHARACTER SELECT
// ---------------------------------------------------------------------------
function buildArcadeLadder() {
  const rest = ROSTER.filter((id) => id !== state.p1Fighter && id !== 'edison');
  state.arcadeLadder = rest.concat(state.p1Fighter === 'edison' ? [] : ['edison']);
  state.arcadeIndex = 0;
}

function moveGridCursor(cur, prev, field, cols, count) {
  let idx = state[field];
  const rows = Math.ceil(count / cols);
  const col = idx % cols, row = (idx / cols) | 0;
  if (edge(cur, prev, BIT.LEFT)) idx = row * cols + ((col + cols - 1) % cols);
  if (edge(cur, prev, BIT.RIGHT)) idx = row * cols + ((col + 1) % cols);
  if (edge(cur, prev, BIT.UP) || edge(cur, prev, BIT.DOWN)) idx = ((row + 1) % rows) * cols + col;
  state[field] = Math.min(count - 1, idx);
}

function updateSelect(cur) {
  const mode = state.mode;
  // Practice picks the dummy with the SAME P1 controls a tick AFTER the player's
  // own fighter is locked, so one LIGHT edge never confirms both at once.
  const p1WasConfirmed = state.selConfirmedP1;

  if (!state.selConfirmedP1) {
    moveGridCursor(cur.local, state.prevLocal, 'selCursorP1', 4, ROSTER.length);
    if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) {
      state.selConfirmedP1 = true;
      state.p1Fighter = ROSTER[state.selCursorP1];
      if (mode === 'arcade') buildArcadeLadder();
      // Online: seat 2's cfg goes out at fighter confirm (it has no stage
      // pick); seat 1's cfg is sent at stage confirm WITH the stage vote -
      // the server starts the match only when it has both.
      else if (mode === 'online' && state.netSeat === 2) sendNetCfg();
    } else if (mode !== 'online' && edge(cur.local, state.prevLocal, BIT.HEAVY)) {
      go('menu');
      return;
    }
  } else if (mode !== 'online' && edge(cur.local, state.prevLocal, BIT.HEAVY)) {
    state.selConfirmedP1 = false;
    return;
  }

  if (mode === 'local') {
    if (!state.selConfirmedP2) {
      moveGridCursor(cur.p2local, state.prevP2local, 'selCursorP2', 4, ROSTER.length);
      if (edge(cur.p2local, state.prevP2local, BIT.LIGHT) || edge(cur.p2local, state.prevP2local, BIT.START)) {
        state.selConfirmedP2 = true;
      }
    } else if (edge(cur.p2local, state.prevP2local, BIT.HEAVY)) {
      state.selConfirmedP2 = false;
    }
  }

  // Practice: after the player's fighter is locked, the SAME P1 pad picks the
  // training dummy (its behavior is set later in the pause practice panel).
  if ((mode === 'practice' || mode === 'duel') && p1WasConfirmed && !state.selConfirmedP2) {
    moveGridCursor(cur.local, state.prevLocal, 'selCursorP2', 4, ROSTER.length);
    if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) {
      state.selConfirmedP2 = true;
      state.p2Fighter = ROSTER[state.selCursorP2];
    }
  }

  if (mode === 'arcade' && state.selConfirmedP1) {
    state.p2Fighter = state.arcadeLadder[0];
    go('stageSelect');
  } else if (mode === 'local' && state.selConfirmedP1 && state.selConfirmedP2) {
    state.p2Fighter = ROSTER[state.selCursorP2];
    go('stageSelect');
  } else if ((mode === 'practice' || mode === 'duel') && state.selConfirmedP1 && state.selConfirmedP2) {
    go('stageSelect');
  } else if (mode === 'online' && state.selConfirmedP1) {
    go('stageSelect');
  }
}

function drawCursorTag(ctx, x, y, label, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 2, 64, 26);
  ctx.fillStyle = '#0E0E10';
  ctx.font = '900 15px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 32, y + 11);
}

function drawFighterCard(ctx, id, x, y, w, h, i) {
  const fd = FIGHTERS && FIGHTERS[id];
  const hex = (fd && fd.brandHex) || CYAN;
  const isP1 = state.selCursorP1 === i;
  const practicePickingDummy = (state.mode === 'practice' || state.mode === 'duel') && state.selConfirmedP1 && !state.selConfirmedP2;
  const isP2 = (state.mode === 'local' || practicePickingDummy) && state.selCursorP2 === i;

  ctx.fillStyle = CARD;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = hex;
  ctx.lineWidth = (isP1 || isP2) ? 6 : 3;
  ctx.strokeRect(x, y, w, h);

  const im = img('./assets/portraits/' + id + '.png');
  if (im._ok) {
    ctx.drawImage(im, x + 10, y + 10, w - 20, h - 90);
  } else {
    ctx.fillStyle = hex + '33';
    ctx.fillRect(x + 10, y + 10, w - 20, h - 90);
    chunkyText(ctx, (id[0] || '?').toUpperCase(), x + w / 2, y + (h - 90) / 2 + 10, 90, hex);
  }

  chunkyText(ctx, t('fn_' + id), x + w / 2, y + h - 52, 26, '#fff');
  chunkyText(ctx, t('arch_' + id), x + w / 2, y + h - 22, 16, 'rgba(255,255,255,0.55)');

  if (id === 'edison') {
    ctx.save();
    ctx.translate(x + w - 6, y + 6);
    ctx.rotate(0.18);
    ctx.fillStyle = GOLD;
    ctx.fillRect(-86, -2, 92, 30);
    ctx.fillStyle = '#3a2a00';
    ctx.font = '900 16px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('select_boss_badge'), -40, 14);
    ctx.restore();
  }

  if (isP1) drawCursorTag(ctx, x, y, t('select_p1'), CYAN);
  if (isP2) drawCursorTag(ctx, x, y + h - 30, t('select_p2'), '#FF8A3D');
}

function drawSelectPanel(ctx, id) {
  const y = H - 190;
  ctx.fillStyle = 'rgba(22,199,228,0.08)';
  ctx.fillRect(W * 0.08, y, W * 0.84, 130);
  const isEdison = id === 'edison';
  const subtitle = isEdison ? t('select_edison_subtitle') : t('arch_' + id);
  chunkyText(ctx, t('fn_' + id) + '  -  ' + subtitle, W * 0.5, y + 34, 30, isEdison ? GOLD : CYAN);
  chunkyText(ctx, t('abname_' + id) + ': ' + t('abdesc_' + id), W * 0.5, y + 80, 18, '#fff');
}

// v2.5 online lobby: show the room code so the host can invite a friend (the DOM
// copy-link / WhatsApp buttons carry the actual URL; this just makes the code visible).
function drawRoomPanel(ctx) {
  if (state.mode !== 'online' || state.netSeat !== 1 || !state.roomId) return;
  const txt = t('online_room_label') + ':  ' + String(state.roomId).toUpperCase();
  const cx = W / 2, y = 140;
  ctx.save();
  ctx.font = '900 22px Arial, sans-serif';
  const w = ctx.measureText(txt).width + 44;
  ctx.fillStyle = 'rgba(8,10,16,0.82)';
  ctx.fillRect(cx - w / 2, y - 20, w, 40);
  ctx.strokeStyle = 'rgba(255,215,94,0.5)'; ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, y - 20, w, 40);
  ctx.restore();
  chunkyText(ctx, txt, cx, y, 22, GOLD);
}

function drawSelect(ctx) {
  bg(ctx, DARK);
  const practicePickingDummy = (state.mode === 'practice' || state.mode === 'duel') && state.selConfirmedP1 && !state.selConfirmedP2;
  const duelPickingCpu = state.mode === 'duel' && practicePickingDummy;
  chunkyText(ctx, duelPickingCpu ? t('select_title_opponent') : practicePickingDummy ? t('practice_dummy_title') : t('select_title'), W / 2, 90, 56, practicePickingDummy ? GOLD : CYAN);
  drawRoomPanel(ctx);

  const cols = 4, cellW = 300, cellH = 310, gap = 24;
  const gridW = cols * cellW + (cols - 1) * gap;
  const startX = (W - gridW) / 2, startY = 175;

  ROSTER.forEach((id, i) => {
    const col = i % 4, row = (i / 4) | 0;
    const x = startX + col * (cellW + gap), y = startY + row * (cellH + gap);
    drawFighterCard(ctx, id, x, y, cellW, cellH, i);
  });

  drawSelectPanel(ctx, practicePickingDummy ? ROSTER[state.selCursorP2] : ROSTER[state.selCursorP1]);
  if (state.mode === 'local' || practicePickingDummy) {
    chunkyText(ctx, t('fn_' + ROSTER[state.selCursorP2]), W * 0.5, H - 236, 20, '#FF8A3D');
  }

  if (state.mode === 'online' && state.selConfirmedP1) {
    chunkyText(ctx, t('select_waiting_opponent'), W / 2, H - 60, 28, '#fff');
  } else if (practicePickingDummy) {
    chunkyText(ctx, t(duelPickingCpu ? 'select_confirm_hint' : 'practice_enter_hint'), W / 2, H - 60, 24, 'rgba(255,255,255,0.6)');
  } else if (!state.selConfirmedP1 || (state.mode === 'local' && !state.selConfirmedP2)) {
    chunkyText(ctx, t('select_confirm_hint'), W / 2, H - 60, 24, 'rgba(255,255,255,0.6)');
  }
}

// ---------------------------------------------------------------------------
// STAGE SELECT
// ---------------------------------------------------------------------------
function updateStageSelect(cur) {
  if (state.mode === 'online' && state.netSeat === 2) return; // locked; server onStart will move us on

  if (!state.stageConfirmed) {
    moveGridCursor(cur.local, state.prevLocal, 'stageCursor', 3, STAGE_IDS.length);
    if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) {
      state.stageConfirmed = true;
      state.stageId = STAGE_IDS[state.stageCursor];
      if (state.mode === 'online') sendNetCfg();
      else go('vs');
    } else if (state.mode !== 'online' && edge(cur.local, state.prevLocal, BIT.HEAVY)) {
      go('select', { mode: state.mode });
    }
  }
}

function drawStageCard(ctx, id, x, y, w, h, active) {
  const st = STAGES && STAGES[id];
  const im = img((st && st.file) || ('./assets/stages/' + id + '.png'));
  ctx.fillStyle = CARD;
  ctx.fillRect(x, y, w, h);
  if (im._ok) ctx.drawImage(im, x + 8, y + 8, w - 16, h - 70);
  else { ctx.fillStyle = 'rgba(22,199,228,0.15)'; ctx.fillRect(x + 8, y + 8, w - 16, h - 70); }
  ctx.strokeStyle = active ? CYAN : 'rgba(255,255,255,0.15)';
  ctx.lineWidth = active ? 5 : 2;
  ctx.strokeRect(x, y, w, h);
  chunkyText(ctx, t('st_' + id), x + w / 2, y + h - 32, 24, active ? CYAN : '#fff');
}

function drawStageSelect(ctx) {
  bg(ctx, DARK);
  chunkyText(ctx, t('stage_title'), W / 2, 90, 50, CYAN);
  drawRoomPanel(ctx);

  const locked = state.mode === 'online' && state.netSeat === 2;
  const cols = 3, cellW = 520, cellH = 340, gap = 30;
  const gridW = cols * cellW + (cols - 1) * gap;
  const startX = (W - gridW) / 2, startY = 200;

  STAGE_IDS.forEach((id, i) => {
    const col = i % 3, row = (i / 3) | 0;
    const x = startX + col * (cellW + gap), y = startY + row * (cellH + gap);
    drawStageCard(ctx, id, x, y, cellW, cellH, i === state.stageCursor && !locked);
  });

  if (locked) chunkyText(ctx, t('stage_waiting_opponent'), W / 2, H - 60, 26, '#fff');
  else if (state.mode === 'online' && state.stageConfirmed) chunkyText(ctx, t('select_waiting_opponent'), W / 2, H - 60, 24, '#fff');
}

// ---------------------------------------------------------------------------
// VS SPLASH
// ---------------------------------------------------------------------------
function updateVs(cur) {
  if (state.t > 84 || edge(cur.local, state.prevLocal, BIT.START)) go('fight');
}
function drawVsPortrait(ctx, id, x, y, flip) {
  // v2 asset scheme is per-form; the VS splash always shows the base form
  const im = img('./assets/sprites/' + id + '_f0_full.png');
  if (im._ok) {
    const w = 420, h = 560;
    ctx.save();
    if (flip) {
      ctx.translate(x, y);
      ctx.scale(-1, 1);
      ctx.drawImage(im, -w / 2, -h * 0.62, w, h);
    } else {
      ctx.drawImage(im, x - w / 2, y - h * 0.62, w, h);
    }
    ctx.restore();
  } else {
    drawFighterFallback(ctx, id, x, y, { scale: 2.2 });
  }
}
function drawVs(ctx) {
  bg(ctx, DARK);
  const p = Math.min(1, state.t / 40);
  const e = easeOutBack(p);
  const x1 = lerp(-500, W * 0.28, e);
  const x2 = lerp(W + 500, W * 0.72, e);
  drawVsPortrait(ctx, state.p1Fighter, x1, H * 0.55, false);
  drawVsPortrait(ctx, state.p2Fighter, x2, H * 0.55, true);
  chunkyText(ctx, t('fn_' + state.p1Fighter), W * 0.28, H * 0.86, 40, '#fff');
  chunkyText(ctx, t('fn_' + state.p2Fighter), W * 0.72, H * 0.86, 40, '#fff');
  if (state.t > 40) {
    const a = Math.min(1, (state.t - 40) / 16);
    ctx.save();
    ctx.globalAlpha = a;
    chunkyText(ctx, t('vs_versus'), W / 2, H * 0.5, 140, GOLD);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// FIGHT  -  event -> presentation mapping lives in handleEvents()
// ---------------------------------------------------------------------------
// v2 per-form atlases: assets/atlas/{id}_f{n}.json (n = 0..3, edison 0..1). Key is
// "id_fN". Fallback chain on load failure: form N -> form 0 -> placeholder capsule
// (drawFighter handles the final placeholder step; this just leaves the key `false`).
function ensureAtlasForm(id, form) {
  const key = id + '_f' + form;
  if (state.atlases[key] !== undefined) return key;
  state.atlases[key] = null;
  loadAtlas('./assets/atlas/' + key + '.json')
    .then((a) => { state.atlases[key] = a; })
    .catch(() => {
      if (form !== 0) {
        // fall back to the base-form atlas for this fighter
        const f0key = id + '_f0';
        if (state.atlases[f0key] === undefined) ensureAtlasForm(id, 0);
        state.atlases[key] = false;
      } else {
        console.warn('[screens] atlas load failed', key);
        state.atlases[key] = false;
      }
    });
  return key;
}
// Prefetch the NEXT form's atlas once ki passes the halfway mark, so transforming
// mid-match never hitches on a cold fetch. Tracked per id_fN so we only try once.
function maybePrefetchNextForm(id, form, ki) {
  if (!(ki > 50)) return;
  const F = FIGHTERS && FIGHTERS[id];
  const forms = F && F.forms;
  if (!forms || form + 1 >= forms.length) return;
  const key = id + '_f' + (form + 1);
  if (state.atlasNextTried.has(key)) return;
  state.atlasNextTried.add(key);
  ensureAtlasForm(id, form + 1);
  ensureAtlasFormX(id, form + 1); // warm the next form's supplemental combo sheet too
}
function resolvedAtlasFor(id, form) {
  const key = id + '_f' + form;
  const a = state.atlases[key];
  if (a) return a;
  if (a === undefined) ensureAtlasForm(id, form);
  if (form !== 0) {
    const f0 = state.atlases[id + '_f0'];
    if (f0) return f0;
    if (f0 === undefined) ensureAtlasForm(id, 0);
  }
  return null;
}

// ---- v2.2 supplemental combo-sheet atlas (id_fN_x) --------------------------
// Extends the per-form atlas mechanism with the optional supplemental sheet that
// carries the extra combo/air/knockdown poses. Keyed "id_fN_x" in state.atlases;
// null while loading, false when absent (renderer then uses the fallback map).
// NO fall-through to form 0: the contract wants the CURRENT form's _x sheet or the
// procedural fallback, nothing in between.
const SUPP_POSES = new Set(['c_straight', 'c_hook', 'c_launcher', 'c_body', 'c_knee', 'c_smash', 'dash_lunge', 'air_hurt', 'air_spin', 'lie_flat']);
const SUPP_FALLBACK = {
  c_straight: 'punchL', c_hook: 'punchH', c_launcher: 'kickH',
  c_body: 'punchH', c_knee: 'kickL', c_smash: 'punchH',
  dash_lunge: 'walk', air_hurt: 'hit', air_spin: 'hit', lie_flat: 'ko',
};
function ensureAtlasFormX(id, form) {
  const key = id + '_f' + form + '_x';
  if (state.atlases[key] !== undefined) return key;
  state.atlases[key] = null;
  loadAtlas('./assets/atlas/' + id + '_f' + form + '_x.json')
    .then((a) => { state.atlases[key] = a; })
    .catch(() => { state.atlases[key] = false; }); // absent: procedural fallback path
  return key;
}
function resolvedXAtlasFor(id, form) {
  const key = id + '_f' + form + '_x';
  const a = state.atlases[key];
  if (a) return a;
  if (a === undefined) ensureAtlasFormX(id, form);
  return null;
}

// ---- v2.2 unique-ultimate FX atlas (assets/atlas/fx_ult.json) ---------------
// Loaded once at boot alongside the fx atlas. undefined=untried, null=loading,
// false=absent (procedural beam), object=loaded. Poses keyed by fighter id:
// ult_<id>_beam (tileable), ult_<id>_muzzle, ult_<id>_impact.
function ensureFxUltAtlas() {
  if (state.fxUlt !== undefined) return;
  state.fxUlt = null;
  loadAtlas('./assets/atlas/fx_ult.json')
    .then((a) => { state.fxUlt = a; })
    .catch(() => { state.fxUlt = false; });
}
function atlasHasPose(atlas, name) {
  return !!(atlas && atlas.poses && atlas.poses[name]);
}

// ---- v2.4 ki-blast FX atlas (assets/atlas/fx_blast.json) --------------------
// Mirrors ensureFxUltAtlas exactly: undefined=untried, null=loading, false=absent
// (renderer falls back to the ult-muzzle art path, then the procedural fireball),
// object=loaded. Poses keyed by fighter id: blast_<id>_head, blast_<id>_travel,
// blast_<id>_impact1, blast_<id>_impact2. No charge/windup pose - the ki blast
// never charges (only the ultimate does).
function ensureFxBlastAtlas() {
  if (state.fxBlast !== undefined) return;
  state.fxBlast = null;
  loadAtlas('./assets/atlas/fx_blast.json')
    .then((a) => { state.fxBlast = a; })
    .catch(() => { state.fxBlast = false; });
}

function startMatch() {
  const roundsToWin = roundsToWinFromOpts();
  const seed = state.mode === 'online'
    ? (state.netSeed >>> 0)
    : ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);

  state.match = createMatch({
    p1: { fighterId: state.p1Fighter },
    p2: { fighterId: state.p2Fighter },
    stageId: state.stageId,
    roundsToWin,
    seed,
    timerSecs: 99,
  });

  state.comboPop = [0, 0];
  state.prevCombo = [0, 0];
  state.roundSplash = null;
  state.roundEndSplash = null;
  state.matchEndPending = null;
  state.perfectThisRound = false;
  state.hashMismatchStreak = 0;
  state.remoteInputs.clear();
  state.localScheduled.clear();
  state.hashSentAt.clear();

  ensureAtlasForm(state.p1Fighter, 0);
  ensureAtlasForm(state.p2Fighter, 0);
  ensureAtlasFormX(state.p1Fighter, 0);
  ensureAtlasFormX(state.p2Fighter, 0);
  ensureFxUltAtlas();
  ensureFxBlastAtlas();
  state.atlasNextTried.clear();
  state.koDustDone = [false, false];
  state.hudCache = null;        // rebuilt for this pairing on the first drawHud
  state.hudGhost = [1, 1];
  state.hudTimerPrev = -1;
  state.hudTimerPop = 0;
  state.prevStateName = [null, null];
  state.prevForm = [0, 0];
  state.transformPending = [false, false];
  state.transformDim = [0, 0];
  state.formSplash = null;
  state.kiFlashTt = [0, 0];
  state.cinematic = null;
  state.ultChallengeFx = null;
  state.beamWindow = [0, 0];
  state.beamAnchor = [null, null];
  clearAuraParticles();
  clearBlastImpacts();

  // v2.1: snap the dynamic camera to its target on the first frame (no lerp-in
  // from the corner) and reset the practice trainer readout + frozen timer.
  state.camSnap = true;
  state.howOverlayOpen = false;
  state.practiceStats.totalDmg = 0;
  state.practiceStats.lastDmg = 0;
  state.practiceStats.lastInput = 0;
  state.practiceIndex = 0;
  state.practiceTimer0 = state.match.timer;

  if (state.stageId) stageRt.load(state.stageId);
  audio.music('music_battle');

  if (feel.setShakeEnabled) feel.setShakeEnabled(state.opts.shake);
  if (feel.setFlashEnabled) feel.setFlashEnabled(state.opts.flash);
}

function onRoundStart(ev) {
  const m = state.match;
  state.perfectThisRound = false;
  state.koDustDone = [false, false];
  state.hudGhost = [1, 1];
  const isFinal = m.round >= (m.roundsToWin * 2 - 1);
  const text = isFinal ? t('splash_final_round') : `${t('splash_round_prefix')} ${m.round}`;
  state.roundSplash = { text, tt: 0, phase: 'round' };
  audio.sfx('sfx_bell');
  if (isFinal) audio.vo('vo_final');
  else if (m.round === 1) audio.vo('vo_round1');
  else audio.vo('vo_round2');
}

function onRoundEnd(ev) {
  let text;
  if (ev.data && ev.data.draw) {
    text = ev.data.reason === 'timeout' ? t('splash_time_up') : t('splash_double_ko');
  } else if (state.perfectThisRound) {
    text = t('splash_perfect');
  } else if (ev.data && ev.data.reason === 'timeout') {
    text = t('splash_time_up');
  } else {
    text = t('splash_ko');
  }
  state.roundEndSplash = { text, tt: 0 };
  state.roundSplash = null;
}

function onMatchEnd(ev) {
  audio.vo('vo_youwin');
  state.matchEndPending = 100;
  const m = state.match;
  if (m) embedPost('result', { p1: state.p1Fighter, p2: state.p2Fighter, wins: [m.wins[0], m.wins[1]], winner: m.wins[0] >= m.wins[1] ? 1 : 2, mode: state.mode, stage: state.stageId });
}

// v2.2 crowd cheer: stages.js's stageRt gains cheer(intensity, frames) (added by
// another agent). Guarded so a working copy without it never throws.
function cheer(intensity, frames) {
  if (stageRt && typeof stageRt.cheer === 'function') {
    try { stageRt.cheer(intensity, frames); } catch (_e) { /* ignore */ }
  }
}

function handleEvents(events) {
  if (!events || !events.length) return;
  for (const ev of events) {
    const x = fpToPx(ev.x), y = fpToPx(ev.y);
    const flip = ev.side === 2;
    switch (ev.t) {
      case 'hit': {
        // core.js's 'hit' event carries data:{dmg,combo,source} (melee/projectile/summon),
        // not a heavy flag - dmg magnitude is our best proxy for picking the punchier fx
        // (light ~44-60, heavy/special/super 80+).
        const heavy = !!(ev.data && ev.data.dmg >= 70);
        const beaming = state.beamWindow[ev.side - 1] > 0;
        const heavyHit = heavy || beaming;
        const atkFid = ev.side === 1 ? state.p1Fighter : state.p2Fighter;
        const defFid = ev.side === 1 ? state.p2Fighter : state.p1Fighter;
        // v2.3: seat the impact spark on the defender's STRUCK surface (the side facing
        // the attacker), not dead-centre on the torso. The core 'hit' event is at the
        // defender centre (def.x, def.y-160000 ~ chest height); nudge x toward the
        // attacker by the defender's half-width so the spark reads at the fist contact.
        const atkF = state.match && state.match.fighters[ev.side - 1];
        const atkFacing = atkF ? (atkF.facing < 0 ? -1 : 1) : (ev.side === 1 ? 1 : -1);
        const defHwPx = fpToPx((FIGHTERS[defFid] && FIGHTERS[defFid].hw) || 56000);
        const sparkX = x - atkFacing * defHwPx;
        // v2.3.1 fix: the core 'hit' event y is a LOGICAL offset (def.y-160000 ~160px up),
        // which lands above the DRAWN head. Re-anchor in the renderer to the defender's
        // drawn upper-chest: 0.40 of the 208px drawn cell (~83px) above its real feet.
        const defF = state.match && state.match.fighters[ev.side === 1 ? 1 : 0];
        const sparkY = defF ? (fpToPx(defF.y) - SPRITE_CELL_PX * 0.40) : y;
        vfx.spawn(heavyHit ? 'spark_h' : 'spark_l', sparkX, sparkY, { flip });
        feel.hitstop(beaming ? 12 : (heavy ? 8 : 4));
        // v2.2: attacker-keyed impact sfx, shared file fallback while per-fighter clips
        // are still missing (heavier hits pitched a touch lower for weight).
        audio.sfx('sfx_' + atkFid + (heavyHit ? '_hit_h' : '_hit_l'), { fallback: heavyHit ? 'sfx_hit_h' : 'sfx_hit_l', rate: heavyHit ? 0.95 : 1 });
        if (beaming) { feel.shake(10, 16); vfx.spawn('ko_burst', x, y, { flip: false }); }

        // v2.4: ki-blast "boom" - a one-shot art-driven burst (blast_<fid>_impact1/2)
        // at the hit location, ONLY for a genuine ki-blast projectile connect (source
        // 'projectile', not the ultimate beam - `beaming` already covers that impact
        // with its own bigger flare in drawBeam, so skip here to avoid doubling up).
        // Whiffs never reach this branch (no 'hit' event fires - ttl despawn is silent).
        if (!beaming && ev.data && ev.data.source === 'projectile') {
          spawnBlastImpact(atkFid, sparkX, sparkY, flip);
          feel.shake(6, 4);
        }

        // v2 hit vocalizations: attacker grunt (alternated deterministically by frame
        // parity - no Math.random) + victim hurt (hurt takes priority in audio.voice()).
        const gruntKind = (state.match && (state.match.frame % 2 === 0)) ? 'grunt1' : 'grunt2';
        audio.voice(atkFid, gruntKind);
        audio.voice(defFid, 'hurt');

        // v2.2: rally the crowd on a real combo (attacker's live hit count >= 3).
        const atkCombo = (state.match && state.match.fighters[ev.side - 1] && state.match.fighters[ev.side - 1].combo) || 0;
        if (atkCombo >= 3) cheer(0.4, 45);

        // interrupted transform: a hit landing on a fighter mid-transform fizzles it
        // (core halves their ki on this same hit; the completion 'transform' event
        // simply never arrives - detected here so we can clear the dim + puff).
        const victimIdx = ev.side === 1 ? 1 : 0;
        if (state.transformPending[victimIdx]) {
          state.transformPending[victimIdx] = false;
          state.transformDim[victimIdx] = 0;
          vfx.spawn('dust', x, y, { flip: !flip });
        }
        break;
      }
      case 'block':
        vfx.spawn('block', x, y, { flip });
        feel.hitstop(2);
        audio.sfx('sfx_hit_l');
        break;
      case 'throw':
        if (ev.data && ev.data.tech) {
          vfx.spawn('dust', x, y, { flip }); // throw broken: lighter feedback, no hitstop/sfx
        } else {
          vfx.spawn('dust', x, y, { flip });
          feel.hitstop(6);
          audio.sfx('sfx_hit_h');
        }
        break;
      case 'dash': {
        // v2.3 fix: the 'dash' event carries NO x/y, so the generic x=fpToPx(ev.x)
        // resolved to world origin (0,0) and the old one-shot 'trail' spawned a stray
        // streak detached at (0,-80) - the "fire on head" bug. The travelling streak
        // afterimage is spawned per-tick in updatePresentation at the fighter's REAL
        // position for the whole dash, so here we only add a start-of-dash dust puff,
        // anchored to the dashing fighter's own feet (from its authoritative sim pos).
        const df = state.match && state.match.fighters[ev.side - 1];
        if (df) vfx.spawn('dust', fpToPx(df.x), fpToPx(df.y), { flip });
        break;
      }
      case 'airdash': {
        // v2.4: unlike 'dash' above, WP1's 'airdash' event DOES carry real world x/y -
        // use them directly (x/y are already fpToPx(ev.x/ev.y) from the top of this
        // loop). A start-of-air-dash streak + small dust puff; the per-tick trailing
        // streak for the rest of the dash is handled in updatePresentation.
        vfx.spawn('trail', x, y, { flip });
        vfx.spawn('dust', x, y, { flip });
        break;
      }
      case 'land':
        vfx.spawn('dust', x, y, { flip: false });
        break;
      case 'projectile':
        // v2.4.1: the ultimate beam projectile usually despawns the SAME sim tick it
        // spawns (it spans the arena and hits instantly), so capture its anchor + the
        // caster's real facing here. drawBeamWindows renders from this for the whole
        // beamWindow; the pool slot cannot drive the beam (and its vx is 0, so it
        // could not even give a direction for a left-facing caster).
        if (ev.data && ev.data.beam) {
          const bf = state.match && state.match.fighters[ev.side - 1];
          state.beamAnchor[ev.side - 1] = { x, y, dir: (bf && bf.facing < 0) ? -1 : 1 };
        }
        vfx.spawn('trail', x, y, { flip });
        break;
      case 'special':
        // covers both a true directional special (data:{move,name}) and a signature
        // ability (data:{ability,...}) - core.js emits both under the 'special' event type.
        vfx.spawn('trail', x, y, { flip });
        audio.sfx('sfx_special');
        break;
      case 'superFlash': {
        const fid = ev.side === 1 ? state.p1Fighter : state.p2Fighter;
        const hex = (FIGHTERS && FIGHTERS[fid] && FIGHTERS[fid].brandHex) || '#FFFFFF';
        feel.flash(hex, 10); // no-ops internally if the flash option is off (setFlashEnabled)
        feel.slowmo(0.5, 20);
        vfx.spawn('super_ring', x, y, { flip });
        audio.sfx('sfx_special');
        break;
      }
      case 'meterFull':
        // continuous cue: drawHud renders the super meter gold + pulsing once full.
        break;
      case 'swing': {
        // whoosh streak on the active-frame start of every attack; a quiet sfx only
        // for heavy swings (data.heavy) so light jabs stay silent-but-visible.
        // v2.2: an arc 'slash' so a missed attack still reads as a visible swing.
        // v2.3: seat the streak + arc IN FRONT of the striking fist on the attacker's
        // facing side (event x is already the hitbox front edge; push it a forward reach
        // further along facing), and pin the height to the chest, never the head.
        const swFid = ev.side === 1 ? state.p1Fighter : state.p2Fighter;
        const swF = state.match && state.match.fighters[ev.side - 1];
        const swFacing = swF ? (swF.facing < 0 ? -1 : 1) : (ev.side === 1 ? 1 : -1);
        const reachPx = fpToPx((FIGHTERS[swFid] && FIGHTERS[swFid].hw) || 56000) + 44;
        const swX = x + swFacing * reachPx;
        // v2.3.1 fix: anchor to the DRAWN sprite, not logical height. 0.30 of the 208px
        // drawn cell = ~62px above the feet = the drawn chest, safely below the drawn head
        // (~100px up). The old 0.58*logical-height overshot ~190px, floating the arc above
        // the drawn head. Keep the Math.max guard so low attacks still read low.
        const chestY = swF ? (fpToPx(swF.y) - SPRITE_CELL_PX * 0.30) : y;
        const swY = swF ? Math.max(y, chestY) : y;
        const swFlip = swFacing < 0;
        vfx.spawn('trail', swX, swY, { flip: swFlip });
        vfx.spawn('slash', swX, swY, { flip: swFlip });
        if (ev.data && ev.data.heavy) audio.sfx('sfx_special', 0.16);
        break;
      }
      case 'kiFull': {
        const fid = ev.side === 1 ? state.p1Fighter : state.p2Fighter;
        const f = state.match && state.match.fighters[ev.side - 1];
        const hex = currentFormAuraHex(fid, (f && f.form) || 0);
        spawnAuraBurst(x, y, hex, 16);
        state.kiFlashTt[ev.side - 1] = 40;
        audio.sfx('sfx_special', 0.35); // quiet chime cue
        break;
      }
      case 'transformStart': {
        state.transformDim[ev.side - 1] = 45; // matches core's 45f transform window
        state.transformPending[ev.side - 1] = true;
        break;
      }
      case 'transform': {
        const side = ev.side;
        const fid = side === 1 ? state.p1Fighter : state.p2Fighter;
        const form = (ev.data && ev.data.form) || 0;
        const hex = currentFormAuraHex(fid, form);
        state.transformPending[side - 1] = false;
        state.transformDim[side - 1] = 0;
        spawnAuraBurst(x, y, hex, 34);
        feel.shake(14, 24);
        feel.flash(hex, 12);
        state.formSplash = { text: t('form_' + fid + '_' + form), tt: 0, hex };
        audio.vo('vo_transform');
        audio.voice(fid, 'transform');
        cheer(0.7, 90);
        break;
      }
      case 'ultChallenge': {
        // v2.5 REACTION WINDOW: an ultimate was fired; the opponent (respSide) now has a
        // short beat to answer with their own to force a clash. Presentation-only - the
        // live countdown is DRAWN from core's authoritative m.ultChallenge each frame.
        state.ultChallengeFx = { respSide: (ev.data && ev.data.respSide) || 0, max: (ev.data && ev.data.window) || 1, tt: 0 };
        feel.shake(6, 10);
        audio.vo('vo_ultimate');
        audio.sfx('sfx_special', 0.5);
        break;
      }
      case 'ultimate': {
        const side = ev.side;
        const fid = side === 1 ? state.p1Fighter : state.p2Fighter;
        const isEdison = fid === 'edison' || !!(ev.data && ev.data.edison);
        state.cinematic = { side, tt: 0, edison: isEdison, fid, flashed: false };
        audio.vo('vo_ultimate');
        // v2.2: per-fighter ultimate sfx (shared 'sfx_special' fallback). The charge
        // yell is NOT played here - the charge-state-entry voice call is the only one.
        audio.sfx('sfx_' + fid + '_ult', { fallback: 'sfx_special' });
        cheer(1, 150);
        break;
      }
      case 'clashStart': {
        // v2.3 ULTIMATE CLASH: two ultimates collide. Begin the clash cinematic - a
        // presentation-only object; the live struggle is DRAWN each frame from core's
        // authoritative clash* fields (clashActive/clashMidX/clashPush/clashMash0-1).
        // cx/cy store the collision-point in WORLD px (mapped through CAM at draw time);
        // resolveTt<0 means "still clashing", it starts counting once resolved.
        state.clashFx = { tt: 0, resolveTt: -1, winner: 0, cx: fpToPx(ev.x), cy: fpToPx(ev.y) };
        feel.shake(10, 20);
        audio.sfx('sfx_special', 0.5);
        cheer(1, 150);
        break;
      }
      case 'clashResolve': {
        // winner burst + end of the cinematic (a short tail plays, then updatePresentation
        // clears state.clashFx). winner: 1|2 (0 = draw). Re-anchor to the resolve point.
        if (state.clashFx) {
          state.clashFx.winner = (ev.data && ev.data.winner) || ev.winner || 0;
          state.clashFx.resolveTt = 0;
          if (typeof ev.x === 'number') state.clashFx.cx = fpToPx(ev.x);
          if (typeof ev.y === 'number') state.clashFx.cy = fpToPx(ev.y);
        }
        feel.shake(16, 26);
        feel.flash('#FFFFFF', 10);
        audio.sfx('sfx_ko');
        cheer(1, 150);
        break;
      }
      case 'perfect':
        state.perfectThisRound = true;
        vfx.spawn('confetti', x, y, { flip: false });
        audio.vo('vo_perfect');
        break;
      case 'roundStart':
        onRoundStart(ev);
        break;
      case 'roundEnd':
        onRoundEnd(ev);
        break;
      case 'matchEnd':
        onMatchEnd(ev);
        break;
      case 'timeout':
        // presentation handled by the 'roundEnd' event that follows in the same tick
        break;
      case 'ko': {
        // core.js also fires 'ko' on a timeout decision (reason:'timeout') - skip the
        // slam/slow-mo for that case, a timer running out isn't a knockout.
        const isKoReason = !(ev.data && ev.data.reason === 'timeout');
        if (isKoReason) {
          feel.shake(18, 30); // no-ops internally if the shake option is off (setShakeEnabled)
          feel.slowmo(0.3, 90);
          vfx.spawn('ko_burst', x, y, { flip: false });
          audio.sfx('sfx_ko');
          // v2.2: the LOSER's own KO cry (ev.side is the winner) replaces shared vo_ko.
          const loserFid = ev.side === 1 ? state.p2Fighter : state.p1Fighter;
          audio.voice(loserFid, 'ko');
          cheer(1, 120);
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// v2: per-tick presentation pass - reads core's authoritative form/ki/charging
// fields and drives OUR client-only aura particles, charge-entry voice, atlas
// prefetch, and the various decaying UI timers. Called once per real sim tick
// (both local/arcade and online) right after handleEvents(); never mutates
// match state, only state.* presentation fields + the aura particle pool.
// ---------------------------------------------------------------------------
function updatePresentation() {
  const m = state.match;
  if (!m) return;
  const fids = [state.p1Fighter, state.p2Fighter];

  updateAuraParticles();
  updateBlastImpacts();

  for (let s = 0; s < 2; s++) {
    const f = m.fighters[s];
    if (!f) continue;
    const fid = fids[s];
    const form = f.form || 0;
    const ki = f.ki || 0;

    maybePrefetchNextForm(fid, form, ki);

    const hPx = fpToPx((FIGHTERS[fid] && FIGHTERS[fid].height) || 330000);
    const bodyCenter = hPx * 0.5; // px above the feet to the fighter's mid-body
    const ax = fpToPx(f.x);
    // v2.2: aura anchors at mid-body (height-relative), not a flat 90px head offset.
    const ay = fpToPx(f.y) - bodyCenter;
    const hScale = hPx / 330; // flame spread/size tracks height (clawde ~330px = 1.0)
    const auraHex = currentFormAuraHex(fid, form);

    // v2.1/v2.2/v2.4: trailing streak afterimage for the length of a dash - ground
    // AND the new air dash (dashAirF/dashAirB) share the same per-tick treatment.
    // Anchor at the fighter's body-center (height-relative), not a fixed 80px
    // head-height value.
    if (f.stateName === 'dashF' || f.stateName === 'dashB'
      || f.stateName === 'dashAirF' || f.stateName === 'dashAirB') {
      if ((m.frame + s) % 2 === 0) vfx.spawn('trail', ax, fpToPx(f.y) - bodyCenter, { flip: f.facing < 0 });
    }

    if (f.stateName === 'charge') {
      if (state.prevStateName[s] !== 'charge') audio.voice(fid, 'charge');
      // rising flame aura while charging - spread across ticks so both fighters
      // charging at once still respects the shared AURA_CAP budget.
      if ((m.frame + s) % 2 === 0) spawnAuraFlame(ax, ay, auraHex, true, hScale);
    } else if (form > 0) {
      // persistent subtle aura once transformed: smaller flame layer + occasional spark
      if ((m.frame + s) % 6 === 0) spawnAuraFlame(ax, ay, auraHex, false, hScale);
      if ((m.frame + s) % 41 === 0) spawnAuraBurst(ax, ay, auraHex, 3);
    }

    // v2.2: KO landing dust - once, when the KO'd fighter first rests on the floor.
    if (f.stateName === 'ko' && !state.koDustDone[s] && fpToPx(f.y) >= CAM_FLOOR_Y - 1) {
      state.koDustDone[s] = true;
      vfx.spawn('dust', ax, fpToPx(f.y), { flip: false });
    }

    if (state.kiFlashTt[s] > 0) state.kiFlashTt[s]--;
    if (state.transformDim[s] > 0) state.transformDim[s]--;
    if (state.beamWindow[s] > 0) state.beamWindow[s]--;

    state.prevStateName[s] = f.stateName;
    state.prevForm[s] = form;
  }

  // v2.2 traveling-fireball embers: per active projectile, spawn a 'spark_l' ember every
  // 9th tick at the head. Presentation only (reads core's projectile pool, never mutates
  // it); no per-frame allocations. NOTE: the old per-4th-tick 'trail' spawn was REMOVED -
  // vfx 'trail' maps to the tall 'streak' pose, which vfx.js draws bottom-anchored and
  // zoom-scaled (~370px), so a projectile-height streak towered ~150-200px into the sky as
  // a stray orange horizontal burst. The fireball's own muzzle art + aura cover the head.
  const projs = m.projectiles;
  if (Array.isArray(projs)) {
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      if (!p || !p.active) continue;
      const px = fpToPx(p.x), py = fpToPx(p.y);
      const dir = p.vx < 0 ? -1 : 1;
      if (m.frame % 9 === 0) {
        // v2.4: tint the trailing ember to the FIRING fighter's form-aura colour so the
        // sparks match the ki-blast instead of the old fixed yellow (glow-follows-form).
        const oIdx = p.owner === 2 ? 1 : 0;
        const ofid = oIdx === 0 ? state.p1Fighter : state.p2Fighter;
        const ohex = currentFormAuraHex(ofid, (m.fighters[oIdx] && m.fighters[oIdx].form) || 0);
        vfx.spawn('spark_l', px, py, { flip: dir < 0, color: ohex });
      }
    }
  }

  if (state.formSplash) {
    state.formSplash.tt++;
    if (state.formSplash.tt > 80) state.formSplash = null;
  }

  // v2.5 reaction-window prompt (presentation only; lives exactly as long as core's
  // authoritative m.ultChallenge counter is running).
  if (state.ultChallengeFx) {
    if (m.ultChallenge > 0) state.ultChallengeFx.tt++;
    else state.ultChallengeFx = null;
  }

  // v2.3 ultimate-clash cinematic timers (presentation only; reads core's clash* fields).
  if (state.clashFx) {
    const cf = state.clashFx;
    cf.tt++;
    // sim ended the clash without us seeing a 'clashResolve' event yet -> begin the tail
    // anyway so the cinematic always closes cleanly.
    if (!m.clashActive && cf.resolveTt < 0) cf.resolveTt = 0;
    if (cf.resolveTt >= 0) cf.resolveTt++;
    if (cf.resolveTt > 46 && !m.clashActive) state.clashFx = null;
  }

  if (state.cinematic) {
    const c = state.cinematic;
    c.tt++;
    if (!c.flashed && c.tt >= 80) {
      // "at ~tick 80 flash white and slam back to gameplay for the beam"
      // v2.2: tint the flash with the fighter's aura (auraHex mixed 40% into white).
      c.flashed = true;
      const cForm = (m.fighters[c.side - 1] && m.fighters[c.side - 1].form) || 0;
      feel.flash(mixHex('#FFFFFF', currentFormAuraHex(c.fid, cForm), 0.4), 10);
      state.beamWindow[c.side - 1] = 50;
      state.cinematic = null;
    } else if (c.tt > 90) {
      state.cinematic = null;
    }
  }
}

function updateSplashes() {
  if (state.roundSplash) {
    state.roundSplash.tt++;
    if (state.roundSplash.phase !== 'fight' && state.roundSplash.tt > 70) {
      state.roundSplash.phase = 'fight';
      state.roundSplash.text = t('splash_fight');
      state.roundSplash.tt = 0;
      audio.vo('vo_fight');
    } else if (state.roundSplash.phase === 'fight' && state.roundSplash.tt > 50) {
      state.roundSplash = null;
    }
  }
  if (state.roundEndSplash) {
    state.roundEndSplash.tt++;
    if (state.roundEndSplash.tt > 110) state.roundEndSplash = null;
  }
}

function updateComboCounters() {
  const m = state.match;
  for (let s = 0; s < 2; s++) {
    const combo = (m.fighters[s] && m.fighters[s].combo) || 0;
    if (combo > state.prevCombo[s]) state.comboPop[s] = 14;
    state.prevCombo[s] = combo;
  }
}
function decayComboPops() {
  for (let s = 0; s < 2; s++) if (state.comboPop[s] > 0) state.comboPop[s]--;
}

function updatePauseMenu(cur) {
  if (edge(cur.local, state.prevLocal, BIT.UP)) state.pauseIndex = (state.pauseIndex + 2) % 3;
  if (edge(cur.local, state.prevLocal, BIT.DOWN)) state.pauseIndex = (state.pauseIndex + 1) % 3;
  if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) {
    if (state.pauseIndex === 0) state.paused = false;
    else if (state.pauseIndex === 1) { state.optionsReturnScreen = 'fight'; go('options'); }
    else go('menu');
  }
}

function stepOnline(cur) {
  const m = state.match;
  if (!state.net) return;

  const targetFrame = m.frame + state.localInputDelay;
  if (!state.localScheduled.has(targetFrame)) {
    state.localScheduled.set(targetFrame, cur.local);
    try { state.net.sendInputs(targetFrame, cur.local); } catch (e) { /* ignore */ }
  }

  let steps = 0;
  const MAX_CATCHUP = 6;
  while (steps < MAX_CATCHUP) {
    const f = m.frame;
    const localIn = state.localScheduled.get(f);
    const remoteIn = state.remoteInputs.get(f);
    if (localIn === undefined || remoteIn === undefined) break;

    const in1 = state.netSeat === 2 ? remoteIn : localIn;
    const in2 = state.netSeat === 2 ? localIn : remoteIn;
    const events = stepMatch(m, in1, in2);
    handleEvents(events);
    updateComboCounters();
    updatePresentation();

    if (m.frame % 60 === 0) {
      const h = hashState(m);
      state.hashSentAt.set(m.frame, h);
      try { state.net.sendHash(m.frame, h); } catch (e) { /* ignore */ }
    }

    state.localScheduled.delete(f);
    state.remoteInputs.delete(f);
    steps++;
  }
}

function updateFight(cur) {
  const m = state.match;
  if (!m) return;

  // NOTE: feel.update()/vfx.update()/stageRt.update() are driven by main.js once per
  // RENDERED frame (not here, once per fixed sim tick) - required so feel's hitstop/slowmo
  // countdown keeps advancing in real time even while it is freezing/slowing sim ticks.
  updateSplashes();
  decayComboPops();

  // v2.1 in-fight how-to overlay: HEAVY/START dismisses it. OFFLINE it freezes
  // the sim (a true pause). ONLINE it must NOT stop the sim - fall through so
  // stepOnline() keeps the netcode advancing beneath the overlay.
  if (state.howOverlayOpen) {
    if (edge(cur.local, state.prevLocal, BIT.HEAVY) || edge(cur.local, state.prevLocal, BIT.START)) {
      state.howOverlayOpen = false;
    }
    if (state.mode !== 'online') return;
  }

  if (state.matchEndPending != null) {
    if (state.mode === 'practice') { state.matchEndPending = null; practiceReset(); return; }
    state.matchEndPending--;
    if (state.matchEndPending <= 0) { state.matchEndPending = null; go('result'); return; }
  }

  if (state.mode === 'online') { stepOnline(cur); return; }

  if (state.paused) {
    if (state.mode === 'practice') updatePracticePause(cur);
    else updatePauseMenu(cur);
    return;
  }

  if (edge(cur.local, state.prevLocal, BIT.START) || edge(cur.p2local, state.prevP2local, BIT.START)) {
    state.paused = true;
    state.pauseIndex = 0;
    state.practiceIndex = 0;
    return;
  }

  let in1, in2;
  if (state.mode === 'arcade' || state.mode === 'duel') { in1 = cur.local; in2 = cpuInput(m, 2, state.opts.cpuLevel); }
  else if (state.mode === 'practice') { in1 = cur.local; in2 = practiceDummyInput(m); }
  else { in1 = cur.local; in2 = cur.p2local; }

  const events = stepMatch(m, in1, in2);
  handleEvents(events);
  updateComboCounters();
  updatePresentation();

  // v2.1 PRACTICE post-step housekeeping - runs STRICTLY between ticks, offline
  // only, so the sim is never mutated mid-step and determinism is untouched:
  // refill toggles, frozen timer, and the trainer HUD readout for this tick.
  if (state.mode === 'practice') {
    updatePracticeStats(cur.local, events);
    applyPracticeRefills(m);
    m.timer = state.practiceTimer0;
    // belt-and-braces: practice can NEVER reach the result screen. Any end
    // state (KO with refills off, etc.) resets the session in place.
    if (m.phase === 'over' || m.phase === 'roundEnd') { practiceReset(); return; }
  }
}

// ---------------------------------------------------------------------------
// v2.1 PRACTICE helpers (offline trainer). None of these run in online play and
// none feed non-deterministic values into stepMatch - the dummy input is either
// a fixed held direction or core's own deterministic cpuInput; refills/timer are
// applied only AFTER a completed stepMatch.
// ---------------------------------------------------------------------------
function practiceDummyInput(m) {
  const beh = state.practiceSettings.dummy;
  if (beh === 'idle') return 0;
  if (beh === 'crouch') return BIT.DOWN;
  if (beh === 'jump') return BIT.UP;
  if (beh === 'block') {
    // "block all" = hold the direction AWAY from the player (core decides block
    // at hit time from a held-back input). Dummy is side 2 (fighters[1]).
    const f1 = m.fighters[1], f0 = m.fighters[0];
    if (!f1 || !f0) return 0;
    return (f1.x <= f0.x) ? BIT.LEFT : BIT.RIGHT;
  }
  if (beh === 'cpu1') return cpuInput(m, 2, 1);
  if (beh === 'cpu2') return cpuInput(m, 2, 2);
  if (beh === 'cpu3') return cpuInput(m, 2, 3);
  return 0;
}

function applyPracticeRefills(m) {
  const ps = state.practiceSettings;
  const f0 = m.fighters[0], f1 = m.fighters[1];
  if (!f0 || !f1) return;
  // HP refills BOTH (so the round never ends); KI/METER refill only the player.
  if (ps.refillHp) { f0.hp = f0.maxHp; f1.hp = f1.maxHp; }
  if (ps.refillKi) f0.ki = 100;
  if (ps.refillMeter) f0.meter = 100;
}

// Accumulate the trainer readout from this tick's events. Player is side 1; its
// 'hit' events carry data.dmg. combo hit-count is read live from f.combo in the HUD.
function updatePracticeStats(localInput, events) {
  state.practiceStats.lastInput = localInput;
  if (!events || !events.length) return;
  for (const ev of events) {
    if (ev.t === 'hit' && ev.side === 1 && ev.data) {
      const dmg = ev.data.dmg || 0;
      state.practiceStats.lastDmg = dmg;
      state.practiceStats.totalDmg += dmg;
    }
    // a fresh combo (player back to neutral, opponent recovered) zeroes the tally
    if (ev.t === 'roundStart') { state.practiceStats.totalDmg = 0; state.practiceStats.lastDmg = 0; }
  }
}

// Rebuild the match in place (offline practice only) to reset positions/health
// without re-loading the stage or restarting the music.
function practiceReset() {
  state.match = createMatch({
    p1: { fighterId: state.p1Fighter },
    p2: { fighterId: state.p2Fighter },
    stageId: state.stageId,
    roundsToWin: roundsToWinFromOpts(),
    seed: (Date.now() >>> 0),
    timerSecs: 99,
  });
  state.practiceTimer0 = state.match.timer;
  state.comboPop = [0, 0];
  state.prevCombo = [0, 0];
  state.matchEndPending = null;
  state.roundSplash = null;
  state.roundEndSplash = null;
  state.formSplash = null;
  state.prevStateName = [null, null];
  state.prevForm = [0, 0];
  state.transformPending = [false, false];
  state.transformDim = [0, 0];
  state.kiFlashTt = [0, 0];
  state.beamWindow = [0, 0];
  state.beamAnchor = [null, null];
  state.cinematic = null;
  state.ultChallengeFx = null;
  state.practiceStats.totalDmg = 0;
  state.practiceStats.lastDmg = 0;
  state.koDustDone = [false, false];
  state.hudGhost = [1, 1];
  clearAuraParticles();
  clearBlastImpacts();
  state.camSnap = true;
  state.toast = { text: t('practice_reset_done'), until: 90 };
}

// Practice pause = the practice panel itself (dummy behavior + refill toggles +
// combo-list card toggle + reset/resume/quit). Up/down navigates, left/right
// adjusts a setting, LIGHT/START fires an action row, HEAVY resumes.
function updatePracticePause(cur) {
  if (edge(cur.local, state.prevLocal, BIT.UP)) state.practiceIndex = (state.practiceIndex + PRACTICE_ROWS.length - 1) % PRACTICE_ROWS.length;
  if (edge(cur.local, state.prevLocal, BIT.DOWN)) state.practiceIndex = (state.practiceIndex + 1) % PRACTICE_ROWS.length;
  const row = PRACTICE_ROWS[state.practiceIndex];
  const left = edge(cur.local, state.prevLocal, BIT.LEFT);
  const right = edge(cur.local, state.prevLocal, BIT.RIGHT);
  const confirm = edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START);
  const ps = state.practiceSettings;

  if (row === 'dummy') {
    if (left || right) {
      let i = DUMMY_BEHAVIORS.indexOf(ps.dummy);
      i = (i + (right ? 1 : DUMMY_BEHAVIORS.length - 1)) % DUMMY_BEHAVIORS.length;
      ps.dummy = DUMMY_BEHAVIORS[i];
    }
  } else if (row === 'refillHp') {
    if (left || right || confirm) ps.refillHp = !ps.refillHp;
  } else if (row === 'refillKi') {
    if (left || right || confirm) ps.refillKi = !ps.refillKi;
  } else if (row === 'refillMeter') {
    if (left || right || confirm) ps.refillMeter = !ps.refillMeter;
  } else if (row === 'showCombolist') {
    if (left || right || confirm) ps.showCombolist = !ps.showCombolist;
  } else if (row === 'reset') {
    if (confirm) { practiceReset(); state.paused = false; }
  } else if (row === 'resume') {
    if (confirm) state.paused = false;
  } else if (row === 'quit') {
    if (confirm) go('menu');
  }

  if (edge(cur.local, state.prevLocal, BIT.HEAVY)) state.paused = false;
}

function drawFighterFallback(ctx, id, x, y, opts) {
  const fd = FIGHTERS && FIGHTERS[id];
  const hex = (fd && fd.brandHex) || CYAN;
  const scale = (opts && opts.scale) || 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.ellipse(0, -60 * scale, 46 * scale, 90 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0E0E10';
  ctx.font = `900 ${34 * scale}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((id[0] || '?').toUpperCase(), 0, -60 * scale);
  ctx.restore();
}

function currentFormAuraHex(fid, form) {
  const F = FIGHTERS && FIGHTERS[fid];
  const forms = F && F.forms;
  const entry = forms && forms[form];
  return (entry && entry.auraHex) || (F && F.brandHex) || CYAN;
}

// v2 stateName -> atlas pose additions: 'charge' pose (cell 23) and 'burst' pose
// (cell 24, transform-explosion) layer on top of the existing STATE_TO_POSE map.
const STATE_TO_POSE_V2 = { charge: 'charge', transform: 'burst' };

// Draw one pose that MAY be a supplemental combo/air/knockdown pose: prefer the
// current form's _x atlas when it carries the pose, else remap through the exact
// fallback table into a base pose on the main form atlas, else the capsule.
function drawResolvedPose(ctx, fid, form, poseName, frameT, x, y, opts) {
  if (SUPP_POSES.has(poseName)) {
    const xa = resolvedXAtlasFor(fid, form);
    if (atlasHasPose(xa, poseName)) { drawPose(ctx, xa, poseName, frameT, x, y, opts); return; }
    poseName = SUPP_FALLBACK[poseName] || poseName; // e.g. c_hook -> punchH
  }
  const atlas = resolvedAtlasFor(fid, form);
  if (atlas && atlas.img) {
    drawPose(ctx, atlas, poseName, frameT, x, y, opts);
  } else {
    const hex = (FIGHTERS && FIGHTERS[fid] && FIGHTERS[fid].brandHex) || CYAN;
    drawCapsuleFighter(ctx, hex, poseName, frameT, x, y, opts && opts.flip);
  }
}

function drawFighter(ctx, side, fid, f) {
  if (!f) return;
  const x = fpToPx(f.x), y = fpToPx(f.y);
  // v2.2: flip relative to the art's NATURAL facing. Most sheets face right
  // (artFacing 1); lama's art faces left (artFacing -1), so it must flip on the
  // opposite side. flip = desired-facing differs from the art's baked-in facing.
  const form = f.form || 0;
  // per-form override wins when a single form's sheet was drawn mirrored (e.g. lama f3),
  // else the fighter-wide artFacing. PURELY render metadata - sim facing stays f.facing.
  const ff = FIGHTERS[fid] && FIGHTERS[fid].artFacingForm;
  const artFacing = (ff && ff[form] !== undefined) ? ff[form]
    : ((FIGHTERS[fid] && FIGHTERS[fid].artFacing) || 1);
  const flip = (f.facing < 0) !== (artFacing < 0);

  // resolve the pose name (state -> pose, then combo/air/ko overrides).
  let poseName = STATE_TO_POSE_V2[f.stateName] || poseNameFor(f.stateName);

  // v2.2 per-stage combo poses: while attacking within an auto-combo, the pose comes
  // from the annotated combo entry (data.js). core ignores the key; this is read-only.
  if ((f.stateName === 'attackL' || f.stateName === 'attackH') && f.comboKind) {
    const arr = FIGHTERS[fid] && FIGHTERS[fid][f.comboKind === 'L' ? 'comboLight' : 'comboHeavy'];
    const entry = arr && arr[f.comboStage || 0];
    if (entry && entry.pose) poseName = entry.pose;
  }

  // v2.2 airborne victims: spin while rising, tumble-hurt while falling.
  let spinAngle = 0;
  if (f.airHurt) {
    if (f.vy < 0) {
      poseName = 'air_spin';
      spinAngle = Math.min((f.stateFrame || 0) * 0.3, 1.2) * (flip ? -1 : 1);
    } else {
      poseName = 'air_hurt';
    }
  }

  // v2.2 KO: play the ko pose's 2 cells, then hold 'lie_flat' (fallback: last ko cell).
  if (f.stateName === 'ko') poseName = (f.stateFrame || 0) > 15 ? 'lie_flat' : 'ko';

  // Dash (ground + air) reuses its cells cycled ~2x faster so it reads as a burst.
  const dashing = f.stateName === 'dashF' || f.stateName === 'dashB'
    || f.stateName === 'dashAirF' || f.stateName === 'dashAirB';
  const frameT = dashing ? (f.stateFrame || 0) * 2 : (f.stateFrame || 0);

  if (spinAngle !== 0) {
    // rotate about the fighter's body-center pivot (renderer-side only).
    const pivotY = y - fpToPx((FIGHTERS[fid] && FIGHTERS[fid].height) || 330000) * 0.5;
    ctx.save();
    ctx.translate(x, pivotY);
    ctx.rotate(spinAngle);
    ctx.translate(-x, -pivotY);
    drawResolvedPose(ctx, fid, form, poseName, frameT, x, y, { flip, scale: 1 });
    ctx.restore();
  } else {
    drawResolvedPose(ctx, fid, form, poseName, frameT, x, y, { flip, scale: 1 });
  }
}

function easeOutCubic(p) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3); }

// ---- fireball gradient cache (origin-anchored gradients, reused via ctx transform).
// Radial/linear gradients are built at (0,0) once per (type|hex|radius-bucket) and
// reused every frame - the fireball's flicker/position come from a ctx translate+
// scale, so no per-frame gradient allocation in the hot loop.
const fireGradCache = new Map();
function fireGrad(ctx, type, hex, r) {
  const key = type + '|' + hex + '|' + (r | 0);
  let g = fireGradCache.get(key);
  if (g) return g;
  if (type === 'aura') {
    g = ctx.createRadialGradient(0, 0, r * 0.15, 0, 0, r * 1.6);
    g.addColorStop(0, rgba(hex, 0.35));
    g.addColorStop(1, rgba(hex, 0));
  } else if (type === 'mid') {
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, rgba(hex, 0.9));
    g.addColorStop(1, rgba(hex, 0));
  } else if (type === 'core') {
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.4);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  } else { // tail: linear behind a rightward-travelling head
    g = ctx.createLinearGradient(0, 0, -r * 2.5, 0);
    g.addColorStop(0, rgba(hex, 0.5));
    g.addColorStop(1, rgba(hex, 0));
  }
  fireGradCache.set(key, g);
  return g;
}

// ---- summon orb gradient cache (same origin-anchored pattern as fireGrad above). The
// orb radius is currently a constant (r=46 in drawEntities) but is bucketed in case it
// ever pulses, so the cache never grows unbounded from float jitter.
const summonGradCache = new Map();
function summonGrad(ctx, hex, r) {
  const bucket = Math.round(r / 4) * 4;
  const key = hex + '|' + bucket;
  let g = summonGradCache.get(key);
  if (g) return g;
  g = ctx.createRadialGradient(0, 0, 2, 0, 0, bucket);
  g.addColorStop(0, hex);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  summonGradCache.set(key, g);
  return g;
}

// ---- ultimate beam impact flare gradient cache (same origin-anchored pattern as
// fireGrad). flareR only ever takes two values (covers ? 148 : 40 in drawBeam), so this
// cache stays tiny; keyed by layer + hex + flareR so outer/mid/core never collide.
const beamFlareGradCache = new Map();
function beamFlareGrad(ctx, layer, hex, flareR) {
  const key = layer + '|' + hex + '|' + (flareR | 0);
  let g = beamFlareGradCache.get(key);
  if (g) return g;
  if (layer === 'outer') {
    g = ctx.createRadialGradient(0, 0, flareR * 0.1, 0, 0, flareR * 1.35);
    g.addColorStop(0, rgba(hex, 0.55));
    g.addColorStop(1, 'rgba(0,0,0,0)');
  } else if (layer === 'mid') {
    g = ctx.createRadialGradient(0, 0, 2, 0, 0, flareR);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.4, rgba(hex, 0.85));
    g.addColorStop(1, rgba(hex, 0));
  } else { // core
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, flareR * 0.4);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  }
  beamFlareGradCache.set(key, g);
  return g;
}

// Reused scratch opts + memoized pose names so the art-path fireball allocates NOTHING
// per frame (drawPose reads opts immediately and never retains the reference; the pose
// name string is built once per fighter id, not once per frame).
const fireArtOpts = { flip: false, scale: 1 };
const fireMuzzleNames = Object.create(null);
function fireMuzzlePoseName(fid) {
  let n = fireMuzzleNames[fid];
  if (n === undefined) { n = 'ult_' + fid + '_muzzle'; fireMuzzleNames[fid] = n; }
  return n;
}

// v2.4: same memoization for the ki-blast FX atlas pose names (fx_blast.json).
const blastArtOpts = { flip: false, scale: 1 };
const blastHeadNames = Object.create(null);
const blastTravelNames = Object.create(null);
function blastHeadPoseName(fid) {
  let n = blastHeadNames[fid];
  if (n === undefined) { n = 'blast_' + fid + '_head'; blastHeadNames[fid] = n; }
  return n;
}
function blastTravelPoseName(fid) {
  let n = blastTravelNames[fid];
  if (n === undefined) { n = 'blast_' + fid + '_travel'; blastTravelNames[fid] = n; }
  return n;
}

// Traveling fireball. ART PATH (v2.4, preferred): when the FIRING fighter's own
// blast_<fid>_head pose exists in the dedicated fx_blast atlas, the projectile head is
// drawn with that PNG art (+ blast_<fid>_travel as a trailing body layer, if present),
// advanced cell-by-cell from the match frame like the muzzle path below. No charge/windup
// orb - the ki blast never charges. FALLBACK 1 (fx_blast untried/loading/absent, or the
// head pose missing): the FIRING fighter's own fire-element muzzle art in the fx_ult
// atlas (ult_<fid>_muzzle), advanced cell-by-cell from the match frame but slowed ~4x
// (Math.floor(frame/4)) for a slow-mo flame feel, mirrored when travelling left
// (e.vx < 0), with a gentle deterministic scale pulse (sin of frame + index,
// render-only, never sim state) over a soft additive glow underlay reusing the cached
// origin-anchored fireGrad aura. No random, no Date.now, no per-frame allocations.
// FALLBACK 2 (both atlases untried/loading/absent, or both poses missing): the fully
// procedural layered aura/mid/core + tail fireball below, byte-identical to before.
// In every path the head/muzzle art follows the LIVE projectile position (x,y) each
// frame - this only replaces the fireball's APPEARANCE, never its motion/speed.
function drawFireball(ctx, x, y, hex, e, index, fid) {
  const m = state.match;
  const frame = m ? m.frame : 0;
  const r = Math.max(28, fpToPx(e.w) * 0.75);
  const dir = e.vx < 0 ? -1 : 1;

  // Kick off both FX atlas loads if a projectile can ever render before startMatch did
  // (idempotent: each ensure* returns immediately once its state field isn't undefined).
  if (state.fxBlast === undefined) ensureFxBlastAtlas();
  if (state.fxUlt === undefined) ensureFxUltAtlas();

  const blast = state.fxBlast;
  const headPose = blastHeadPoseName(fid);
  if (blast && atlasHasPose(blast, headPose)) {
    const tick = Math.floor(frame / 4);                      // deterministic cell advance
    const pulse = 1 + 0.06 * Math.sin(frame * 0.14 + index); // slow gentle render-only breathe
    const scale = (r * 2.2 / blast.cell.h) * pulse;
    const dh = blast.cell.h * scale;
    // SUBTLE additive glow halo tinted by hex. The baked FX art already carries a
    // white-hot core + blue body + soft alpha edges, so this is just a small colored
    // aura behind it - kept low-alpha/small so it does NOT blow the sprite out to white
    // (drawing the sprite itself additively over its own bright core saturates to white).
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45;
    ctx.translate(x, y);
    ctx.fillStyle = fireGrad(ctx, 'aura', hex, r);
    ctx.beginPath(); ctx.arc(0, 0, r * 1.05, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // trailing travel body (if the atlas has it), drawn behind the head along -dir.
    // NORMAL compositing (source-over): preserves the baked blue instead of blowing out.
    const travelPose = blastTravelPoseName(fid);
    if (atlasHasPose(blast, travelPose)) {
      ctx.save();
      blastArtOpts.flip = dir < 0;
      blastArtOpts.scale = scale * 0.9;
      drawPose(ctx, blast, travelPose, tick, x - dir * dh * 0.5, y + dh / 2, blastArtOpts);
      ctx.restore();
    }
    // leading head/tip, centered on the LIVE projectile position (bottom-center anchor
    // -> pass y + dh/2 so the art's vertical middle lands on y, same as the muzzle path).
    ctx.save();
    blastArtOpts.flip = dir < 0;
    blastArtOpts.scale = scale;
    drawPose(ctx, blast, headPose, tick, x, y + dh / 2, blastArtOpts);
    ctx.restore();
    return;
  }

  const ult = state.fxUlt;
  const muzzlePose = fireMuzzlePoseName(fid);
  if (ult && atlasHasPose(ult, muzzlePose)) {
    // v2.3: slowed to ~4x (was /2) so the flame reads frame-by-frame as it travels,
    // with a gentler slower breathe/flicker. Muzzle pose is keyed by FIGHTER ID (fid),
    // never by form, so a fighter keeps the SAME fire art after powering up - form only
    // tints the additive glow underlay below (hex from currentFormAuraHex at the call
    // site), it never swaps the art. Deterministic (frame + index), no random/Date.now.
    const tick = Math.floor(frame / 4);                      // ~4x slower cell advance
    const pulse = 1 + 0.06 * Math.sin(frame * 0.14 + index); // slow gentle render-only breathe
    const scale = (r * 2.6 / ult.cell.h) * pulse;
    const dh = ult.cell.h * scale;
    // soft additive glow underlay (cached aura gradient is origin-anchored, so translate)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.fillStyle = fireGrad(ctx, 'aura', hex, r);
    ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // muzzle art as the projectile head, centered on the travel point (bottom-center
    // anchor -> pass y + dh/2 so the art's vertical middle lands on y).
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    fireArtOpts.flip = dir < 0;
    fireArtOpts.scale = scale;
    drawPose(ctx, ult, muzzlePose, tick, x, y + dh / 2, fireArtOpts);
    ctx.restore();
    return;
  }

  // ---- fallback: fully procedural layered fireball (unchanged) ----
  const flick = 1 + 0.08 * Math.sin(frame * 1.1 + index);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(x, y);
  ctx.scale(flick, flick);
  if (dir < 0) ctx.scale(-1, 1); // mirror so the cached "tail points left" grads reuse
  // elongated tail (length ~r*2.5) trailing behind the head
  ctx.fillStyle = fireGrad(ctx, 'tail', hex, r);
  ctx.fillRect(-r * 2.5, -r * 0.5, r * 2.5, r);
  // outer aura
  ctx.fillStyle = fireGrad(ctx, 'aura', hex, r);
  ctx.beginPath(); ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2); ctx.fill();
  // mid hex-to-white body (drawn at ~0.8 alpha per the brief)
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = fireGrad(ctx, 'mid', hex, r);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  // white-hot core
  ctx.globalAlpha = 1;
  ctx.fillStyle = fireGrad(ctx, 'core', hex, r);
  ctx.beginPath(); ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Ultimate beam that REACHES the opponent: length runs from the hand anchor to the
// arena edge in the firing direction (min 420), swept in over ~8 ticks. Unique per
// fighter when assets/atlas/fx_ult.json is present (tiled ult_<id>_beam + pulsing
// muzzle + impact pose); otherwise an improved procedural beam tinted the fighter's
// aura. An impact burst fires where the beam covers the opponent (with a shake
// refresh), else an end flare at the arena edge. Core sim/hitbox are untouched.
function drawBeam(ctx, x, y, hex, e, side) {
  const m = state.match;
  const frame = m ? m.frame : 0;
  const dir = (e && e.vx < 0) ? -1 : 1;
  const edgeLen = dir > 0 ? (W - x) : x;
  const fullLen = Math.max(420, edgeLen);
  const bw = state.beamWindow[side - 1] || 0;
  const sweepP = clamp01((50 - bw) / 8);
  const curLen = fullLen * easeOutCubic(sweepP);

  // does the beam's horizontal span currently cover the opponent?
  const oppIdx = side === 1 ? 1 : 0;
  const oppF = m && m.fighters[oppIdx];
  const oppX = oppF ? fpToPx(oppF.x) : null;
  const endX = x + dir * curLen;
  const bx0 = Math.min(x, endX), bx1 = Math.max(x, endX);
  const covers = oppX != null && oppX >= bx0 && oppX <= bx1;
  const hitX = covers ? oppX : endX;

  const fid = side === 1 ? state.p1Fighter : state.p2Fighter;
  const ult = state.fxUlt;
  const beamPose = 'ult_' + fid + '_beam';
  const useAtlas = ult && atlasHasPose(ult, beamPose);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (useAtlas) {
    const scale = 96 / ult.cell.h;               // beam thickness ~96px
    const segW = Math.max(8, ult.cell.w * scale);
    const dh = ult.cell.h * scale;
    const n = Math.min(64, Math.ceil(curLen / segW));
    for (let i = 0; i < n; i++) {
      const segX = x + dir * (i * segW + segW * 0.5);
      drawPose(ctx, ult, beamPose, frame, segX, y + dh / 2, { flip: dir < 0, scale });
    }
    // muzzle pulse at the hand + impact at the hit point (if those poses exist)
    const mpulse = scale * (1 + 0.15 * Math.sin(frame * 0.4));
    if (atlasHasPose(ult, 'ult_' + fid + '_muzzle')) drawPose(ctx, ult, 'ult_' + fid + '_muzzle', frame, x, y + dh / 2, { flip: dir < 0, scale: mpulse });
    // v2.4: draw the ult impact art at ~1.8x the beam scale so the ultimate impact
    // clearly out-scales the ki-blast impact (Image-2 vs Image-3). Recompute the
    // bottom-center anchor offset for the larger scale so it stays centered on the beam.
    if (atlasHasPose(ult, 'ult_' + fid + '_impact')) {
      const impactScale = scale * 1.8;
      const impactDh = ult.cell.h * impactScale;
      drawPose(ctx, ult, 'ult_' + fid + '_impact', frame, hitX, y + impactDh / 2, { flip: dir < 0, scale: impactScale });
    }
  } else {
    // procedural: layered glow + core strokes with an animated edge ripple.
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(hex, 0.5); ctx.lineWidth = 92;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, y); ctx.stroke();
    ctx.strokeStyle = rgba(hex, 0.75); ctx.lineWidth = 48;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, y); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 22;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, y); ctx.stroke();
    // deterministic sine ripple along the edge (from frame, no random)
    ctx.strokeStyle = rgba(hex, 0.55); ctx.lineWidth = 4;
    ctx.beginPath();
    const segs = 24;
    for (let i = 0; i <= segs; i++) {
      const tt = i / segs;
      const rx = x + dir * curLen * tt;
      const ry = y + Math.sin(frame * 0.3 + tt * 20) * 12 * (1 - tt * 0.3);
      if (i === 0) ctx.moveTo(rx, ry); else ctx.lineTo(rx, ry);
    }
    ctx.stroke();
  }

  // v2.4 impact burst where the beam meets the opponent (+ shake refresh); else edge
  // flare. Bigger + more painterly than the ki-blast boom: ~2x radius when covering the
  // opponent, 3 layered radial gradients (white core -> aura -> transparent) + a
  // secondary expanding ring. Still inside this function's outer lighter-composite
  // save/restore; a nested save/translate origin-anchors the cached beamFlareGrad
  // gradients (built once per hex/flareR) instead of rebuilding them at hitX,y every
  // frame. All deterministic from `frame`, no random.
  const flareR = covers ? 148 : 40; // ~2x the old 74px when it covers the opponent
  ctx.save();
  ctx.translate(hitX, y); // origin-anchor so the cached gradients below need no per-frame rebuild

  ctx.fillStyle = beamFlareGrad(ctx, 'outer', hex, flareR);
  ctx.beginPath(); ctx.arc(0, 0, flareR * 1.35, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = beamFlareGrad(ctx, 'mid', hex, flareR);
  ctx.beginPath(); ctx.arc(0, 0, flareR, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = beamFlareGrad(ctx, 'core', hex, flareR);
  ctx.beginPath(); ctx.arc(0, 0, flareR * 0.4, 0, Math.PI * 2); ctx.fill();

  if (covers) {
    const ringP = (frame % 24) / 24; // deterministic from frame, no Math.random
    ctx.strokeStyle = rgba(hex, 0.5 * (1 - ringP));
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(0, 0, flareR * (0.5 + ringP * 0.9), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore(); // pops the translate
  ctx.restore(); // pops the 'lighter' composite from the top of this function

  if (covers && feel.shake) feel.shake(12, 10); // stronger than the ki-blast's shake(6,4)
}

// v2.4.1: render each side's ultimate beam for the whole beamWindow from the anchor
// captured at the beam-spawn event. The sim projectile (kind 2) spans the arena and
// despawns the same tick it hits, so the pool slot cannot drive this render (the old
// path silently relied on the stale slot still being drawn - see Bug Catalog #10/#14).
// The ultimate CLASH has its own renderer, so single beams stay hidden during one.
function drawBeamWindows(ctx) {
  if (state.clashFx || (state.match && state.match.clashActive)) return;
  for (let s = 0; s < 2; s++) {
    if (state.beamWindow[s] <= 0) continue;
    const a = state.beamAnchor[s];
    if (!a) continue;
    const fid = s === 0 ? state.p1Fighter : state.p2Fighter;
    const f = state.match && state.match.fighters[s];
    const hex = currentFormAuraHex(fid, (f && f.form) || 0);
    drawBeam(ctx, a.x, a.y, hex, { vx: a.dir }, s + 1);
  }
}

function drawEntities(ctx, list, kind) {
  if (!Array.isArray(list)) return;
  for (let idx = 0; idx < list.length; idx++) {
    const e = list[idx];
    // v2.4 FIX: only draw LIVE pool entries. Despawned projectiles/summons keep their
    // last x/y in the pool (core sets active=false but does not reset position), so
    // without this guard a blast that hit + despawned stayed drawn frozen on the
    // opponent ("stuck ki blast"). Every other FX pool already skips inactive slots.
    if (!e || !e.active) continue;
    const x = fpToPx(e.x), y = fpToPx(e.y);
    // core.js stores the entity's owning SIDE (1|2) in `owner`, not a fighter id.
    const side = e.owner === 2 ? 2 : 1;
    const fid = side === 1 ? state.p1Fighter : state.p2Fighter;
    const owF = state.match && state.match.fighters[side - 1];
    const hex = currentFormAuraHex(fid, (owF && owF.form) || 0);

    // The genuine ultimate beam (kind===2) is rendered by drawBeamWindows from the
    // anchor captured at its spawn event - the sim slot despawns the same tick it
    // hits, so it cannot drive the 50-tick beam render. Never draw kind 2 from the
    // pool (a whiffed beam surviving a few ticks would double-draw over the window
    // render). A plain blast (kind===1) or flurry (kind===3) still draws as a fireball.
    if (kind === 'proj' && e.kind === 2) continue;

    if (kind === 'proj') { drawFireball(ctx, x, y, hex, e, idx, fid); continue; }

    // summons keep the simple additive orb.
    const r = 46;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y); // origin-anchor so the cached gradient below needs no per-frame rebuild
    ctx.fillStyle = summonGrad(ctx, hex, r);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ===========================================================================
// v2.2 HUD REDESIGN - retro, skewed bars, portrait chips, timer medallion.
// Geometry is fixed; Path2Ds + absolute gradients are precomputed once per fighter
// pairing into state.hudCache (built on the first draw with a real ctx), so the
// per-frame path is allocation-free (only rect-clips + cached path/gradient fills).
// ===========================================================================
const HUD_SKEW = 0.3249; // tan(18deg)
const CHIP = 96, CHIP_R = 14, CHIP_X = 40, CHIP_Y = 26;
const HP_X = 152, HP_Y = 40, HP_W = 560, HP_H = 30;
const SUP_X = 152, SUP_Y = 78, SUP_W = 336, SUP_H = 12, SUP_SEGS = 4, SUP_GAP = 4;
const KI_X = 152, KI_Y = 94, KI_W = 336, KI_H = 6;
// v2.4 mana bar (ki-blast resource): thin violet bar directly under the ki bar,
// reuses the ki bar's X/width so the two thin resource bars stack cleanly.
const MANA_Y = 102, MANA_H = 5;
const NAME_X = 152, NAME_Y = 8, NAME_W = 224, NAME_H = 22;
const TIMER_CX = 960, TIMER_CY = 64, TIMER_R = 60;
const COMBO_Y = 190;
const HP_PLATE = 'rgba(8,10,16,0.85)';

function hudParaPath(x, y, w, h, mirror) {
  const sk = h * HUD_SKEW;
  let tlx = x + sk, trx = x + w + sk, brx = x + w, blx = x;
  if (mirror) { tlx = W - tlx; trx = W - trx; brx = W - brx; blx = W - blx; }
  const p = new Path2D();
  p.moveTo(tlx, y); p.lineTo(trx, y); p.lineTo(brx, y + h); p.lineTo(blx, y + h); p.closePath();
  return p;
}
function hudRoundRect(x, y, w, h, r, mirror) {
  const x0 = mirror ? (W - x - w) : x;
  const p = new Path2D();
  p.moveTo(x0 + r, y);
  p.lineTo(x0 + w - r, y); p.arcTo(x0 + w, y, x0 + w, y + r, r);
  p.lineTo(x0 + w, y + h - r); p.arcTo(x0 + w, y + h, x0 + w - r, y + h, r);
  p.lineTo(x0 + r, y + h); p.arcTo(x0, y + h, x0, y + h - r, r);
  p.lineTo(x0, y + r); p.arcTo(x0, y, x0 + r, y, r);
  p.closePath();
  return p;
}
function hudVGrad(ctx, y, h, c0, c1) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, c0); g.addColorStop(1, c1);
  return g;
}
function buildHudCache(ctx) {
  const segW = (SUP_W - (SUP_SEGS - 1) * SUP_GAP) / SUP_SEGS;
  const cache = { p1: state.p1Fighter, p2: state.p2Fighter, segW, sides: [], grad: null };
  for (let s = 0; s < 2; s++) {
    const mirror = s === 1;
    const side = {
      hp: hudParaPath(HP_X, HP_Y, HP_W, HP_H, mirror),
      ki: hudRoundRect(KI_X, KI_Y, KI_W, KI_H, KI_H / 2, mirror),
      mana: hudRoundRect(KI_X, MANA_Y, KI_W, MANA_H, MANA_H / 2, mirror),
      chip: hudRoundRect(CHIP_X, CHIP_Y, CHIP, CHIP, CHIP_R, mirror),
      name: hudParaPath(NAME_X, NAME_Y, NAME_W, NAME_H, mirror),
      sup: [], supX: [],
    };
    for (let i = 0; i < SUP_SEGS; i++) {
      const sx = SUP_X + i * (segW + SUP_GAP);
      side.sup.push(hudParaPath(sx, SUP_Y, segW, SUP_H, mirror));
      side.supX.push(sx);
    }
    cache.sides.push(side);
  }
  cache.grad = {
    hpGreen: hudVGrad(ctx, HP_Y, HP_H, '#8CF3B5', '#1FB85C'),
    hpGold: hudVGrad(ctx, HP_Y, HP_H, '#FFE08A', '#C99A16'),
    hpRed: hudVGrad(ctx, HP_Y, HP_H, '#FF8A8A', '#C41E1E'),
    sup: hudVGrad(ctx, SUP_Y, SUP_H, '#7FEFFF', '#0E9FB8'),
    supGold: hudVGrad(ctx, SUP_Y, SUP_H, '#FFE58A', '#D9A21A'),
    mana: hudVGrad(ctx, MANA_Y, MANA_H, '#B9A7FF', '#6E5BD8'),
  };
  state.hudCache = cache;
}
// Fill `path` clipped to the left/right `pct` fraction of a bar of width geoW at
// geoX (skew widens the covered span). Right-side bars drain from the outer edge.
function hudFillPct(ctx, path, geoX, geoW, skew, geoY, geoH, pct, mirror, style) {
  if (pct <= 0) return;
  const span = geoW * pct + skew;
  const clipX = mirror ? (W - geoX - span - 2) : (geoX - 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX, geoY - 2, span + 4, geoH + 4);
  ctx.clip();
  ctx.fillStyle = style;
  ctx.fill(path);
  ctx.restore();
}
function drawComboCounter(ctx, side) {
  const m = state.match;
  const combo = (m.fighters[side] && m.fighters[side].combo) || 0;
  if (combo < 2) return;
  const fid = side === 0 ? state.p1Fighter : state.p2Fighter;
  const hex = currentFormAuraHex(fid, (m.fighters[side].form) || 0); // tint = attacker aura
  const pop = state.comboPop[side] || 0;
  const scale = 1 + (pop / 14) * 0.4;
  ctx.save();
  ctx.translate(side === 0 ? CHIP_X : W - CHIP_X, COMBO_Y);
  ctx.scale(scale, scale);
  chunkyText(ctx, `${combo} ${t('hud_hits_suffix')}`, 0, 0, 30, hex, side === 0 ? 'left' : 'right');
  ctx.restore();
}
function drawWinPips(ctx, total, filled, mirror) {
  const size = 12, gap = 10, y = TIMER_CY;
  for (let i = 0; i < total; i++) {
    const cx = mirror
      ? (TIMER_CX + TIMER_R + 22 + i * (size + gap))
      : (TIMER_CX - TIMER_R - 22 - i * (size + gap));
    ctx.save();
    ctx.translate(cx, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = i < filled ? GOLD : 'rgba(255,255,255,0.16)';
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
    ctx.restore();
  }
}

// v2.3 transform countdown badge: a small aura ring + "Ns" tag pinned to the portrait
// chip's inner-bottom corner, shown only while a fighter is powered up (form>0). The
// ring sweeps down each second (subFrac) for a subtle ticking read of the time left.
function drawFormTimerBadge(ctx, cx, cy, secs, subFrac, hex) {
  const r = 16;
  ctx.save();
  ctx.fillStyle = 'rgba(10,12,18,0.92)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = hex;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(subFrac), false);
  ctx.stroke();
  chunkyText(ctx, secs + 's', cx, cy + 1, 15, '#fff');
  ctx.restore();
}

function drawHud(ctx, m) {
  if (!state.hudCache || state.hudCache.p1 !== state.p1Fighter || state.hudCache.p2 !== state.p2Fighter) buildHudCache(ctx);
  const C = state.hudCache;
  const hpSk = HP_H * HUD_SKEW, supSk = SUP_H * HUD_SKEW;

  for (let s = 0; s < 2; s++) {
    const f = m.fighters[s];
    if (!f) continue;
    const mirror = s === 1;
    const fid = s === 0 ? state.p1Fighter : state.p2Fighter;
    const side = C.sides[s];
    const brandHex = (FIGHTERS[fid] && FIGHTERS[fid].brandHex) || CYAN;
    const auraHex = currentFormAuraHex(fid, f.form || 0);

    // ---- portrait chip (cover-cropped, rounded, brand border) ----
    ctx.save();
    ctx.fillStyle = CARD;
    ctx.fill(side.chip);
    ctx.save();
    ctx.clip(side.chip);
    const im = img('./assets/portraits/' + fid + '.png');
    if (im._ok) {
      const iw = im.naturalWidth || im.width || CHIP;
      const ih = im.naturalHeight || im.height || CHIP;
      const chipX = mirror ? (W - CHIP_X - CHIP) : CHIP_X;
      const sc = Math.max(CHIP / iw, CHIP / ih);
      const dw = iw * sc, dh = ih * sc;
      ctx.drawImage(im, chipX - (dw - CHIP) / 2, CHIP_Y - (dh - CHIP) / 2, dw, dh);
    } else {
      ctx.fillStyle = rgba(brandHex, 0.25);
      ctx.fill(side.chip);
      const chipCx = mirror ? (W - CHIP_X - CHIP / 2) : (CHIP_X + CHIP / 2);
      chunkyText(ctx, (fid[0] || '?').toUpperCase(), chipCx, CHIP_Y + CHIP / 2, 54, brandHex);
    }
    ctx.restore();
    ctx.lineWidth = 3;
    ctx.strokeStyle = brandHex;
    ctx.stroke(side.chip);
    ctx.restore();

    // ---- name tag + form label ----
    ctx.fillStyle = rgba(brandHex, 0.9);
    ctx.fill(side.name);
    chunkyText(ctx, t('fn_' + fid), mirror ? (W - NAME_X - 14) : (NAME_X + 14), NAME_Y + NAME_H / 2, 16, '#0E0E10', mirror ? 'right' : 'left');
    chunkyText(ctx, t('form_' + fid + '_' + (f.form || 0)), mirror ? (W - NAME_X - 8) : (NAME_X + 8), 34, 13, auraHex, mirror ? 'right' : 'left');

    // ---- HP bar with damage-lag ghost ----
    const hpPct = clamp01((f.hp || 0) / (f.maxHp || 1));
    let ghost = state.hudGhost[s];
    if (ghost > hpPct) ghost = Math.max(hpPct, ghost - 0.015); else ghost = hpPct;
    state.hudGhost[s] = ghost;
    ctx.fillStyle = HP_PLATE; ctx.fill(side.hp);
    hudFillPct(ctx, side.hp, HP_X, HP_W, hpSk, HP_Y, HP_H, ghost, mirror, 'rgba(255,255,255,0.35)');
    const hpGrad = hpPct > 0.5 ? C.grad.hpGreen : hpPct > 0.25 ? C.grad.hpGold : C.grad.hpRed;
    hudFillPct(ctx, side.hp, HP_X, HP_W, hpSk, HP_Y, HP_H, hpPct, mirror, hpGrad);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.stroke(side.hp);

    // ---- super meter (4 skewed segments; whole bar gold + pulse at 100) ----
    const supPct = clamp01((f.meter || 0) / 100);
    const full = supPct >= 1;
    const pulse = full ? (0.6 + 0.4 * Math.abs(Math.sin(state.t / 8))) : 1;
    for (let i = 0; i < SUP_SEGS; i++) {
      ctx.fillStyle = HP_PLATE; ctx.fill(side.sup[i]);
      const frac = clamp01(supPct * SUP_SEGS - i);
      if (frac > 0) {
        if (full) {
          ctx.save(); ctx.globalAlpha = pulse;
          hudFillPct(ctx, side.sup[i], side.supX[i], C.segW, supSk, SUP_Y, SUP_H, frac, mirror, C.grad.supGold);
          ctx.restore();
        } else {
          hudFillPct(ctx, side.sup[i], side.supX[i], C.segW, supSk, SUP_Y, SUP_H, frac, mirror, C.grad.sup);
        }
      }
    }

    // ---- ki bar (rounded, aura fill, white flash when full) ----
    const kiPct = clamp01((f.ki || 0) / 100);
    ctx.fillStyle = HP_PLATE; ctx.fill(side.ki);
    const flashing = state.kiFlashTt[s] > 0 && (state.kiFlashTt[s] % 8) < 4;
    hudFillPct(ctx, side.ki, KI_X, KI_W, 0, KI_Y, KI_H, kiPct, mirror, flashing ? '#FFFFFF' : auraHex);

    // ---- mana bar (ki-blast resource; violet, sits under the ki bar) ----
    const manaPct = clamp01((f.mana || 0) / 100);
    ctx.fillStyle = HP_PLATE; ctx.fill(side.mana);
    hudFillPct(ctx, side.mana, KI_X, KI_W, 0, MANA_Y, MANA_H, manaPct, mirror, C.grad.mana);

    drawWinPips(ctx, m.roundsToWin, m.wins[s], mirror);
    drawComboCounter(ctx, s);

    // ---- v2.3 transform countdown: seconds until this powered-up form reverts ----
    // core adds f.formTtl (frames left before revert); guarded so it is a no-op at
    // base form or before core ships the field (undefined > 0 is false).
    if ((f.form || 0) > 0 && (f.formTtl || 0) > 0) {
      const secs = Math.ceil(f.formTtl / 60);
      const subFrac = (f.formTtl % 60) / 60;
      const bx = mirror ? (W - (CHIP_X + CHIP - 12)) : (CHIP_X + CHIP - 12);
      drawFormTimerBadge(ctx, bx, CHIP_Y + CHIP - 12, secs, subFrac, auraHex);
    }
  }

  // ---- centre timer medallion (scale-pop each second; red pulse under 10s) ----
  const practice = state.mode === 'practice';
  const secs = practice ? -1 : Math.max(0, Math.ceil(m.timer / 60));
  if (!practice && secs !== state.hudTimerPrev) { state.hudTimerPop = 8; state.hudTimerPrev = secs; }
  if (state.hudTimerPop > 0) state.hudTimerPop--;
  const popScale = 1 + (state.hudTimerPop / 8) * 0.25;
  const under10 = !practice && secs <= 10;
  const digitColor = under10 ? (state.t % 20 < 10 ? '#FF5A5A' : '#FFD24A') : '#fff';
  ctx.save();
  ctx.fillStyle = 'rgba(10,12,18,0.92)';
  ctx.beginPath(); ctx.arc(TIMER_CX, TIMER_CY, TIMER_R, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = GOLD; ctx.stroke();
  ctx.translate(TIMER_CX, TIMER_CY);
  ctx.scale(popScale, popScale);
  chunkyText(ctx, practice ? t('practice_timer_inf') : String(secs), 0, 0, 56, digitColor);
  ctx.restore();
}

function drawRoundSplash(ctx, s) {
  const p = Math.min(1, s.tt / 12);
  const scale = 0.6 + 0.4 * easeOutBack(p);
  ctx.save();
  ctx.translate(W / 2, H * 0.42);
  ctx.scale(scale, scale);
  chunkyText(ctx, s.text, 0, 0, 90, CYAN);
  ctx.restore();
}
function drawRoundEndSplash(ctx, s) {
  const p = Math.min(1, s.tt / 12);
  const scale = 0.6 + 0.4 * easeOutBack(p);
  ctx.save();
  ctx.translate(W / 2, H * 0.4);
  ctx.scale(scale, scale);
  chunkyText(ctx, s.text, 0, 0, 96, GOLD);
  ctx.restore();
}

// v2: transform completion splash - big form-name text (e.g. "SONNET"), same
// pop-in feel as the round splashes, tinted with the new form's aura color.
function drawFormSplash(ctx, s) {
  const p = Math.min(1, s.tt / 12);
  const scale = 0.6 + 0.4 * easeOutBack(p);
  const fade = s.tt > 60 ? clamp01(1 - (s.tt - 60) / 20) : 1;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(W / 2, H * 0.3);
  ctx.scale(scale, scale);
  chunkyText(ctx, s.text + '!', 0, 0, 100, s.hex || GOLD);
  ctx.restore();
}

// v2: full-screen dim used while a fighter is mid-transform (transformStart ->
// transform/interrupt). Draws at up to ~35% black alpha, proportional to the
// larger of the two sides' remaining dim timer (45f window).
function drawTransformDim(ctx) {
  const tt = Math.max(state.transformDim[0] || 0, state.transformDim[1] || 0);
  if (tt <= 0) return;
  const a = Math.min(1, tt / 45) * 0.35;
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${a})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// -------------------------------------------------------------------------
// v2: ULTIMATE cinematic - letterbox bars, vignette, the attacker's painted
// portrait sliding/zooming in from their side with radiating procedural speed
// lines + a pulsing aura-colored glow. Edison's ultimate additionally draws a
// simple procedural laptop with upward-raining green code + throttled quiet
// "keyboard clatter" sfx bursts. Ends (via updatePresentation) with a white
// flash around tick 80 that clears state.cinematic and hands off to the beam.
// -------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// v2.3 ULTIMATE CLASH cinematic. Two ultimates collide: letterbox in, two aura-
// tinted beams meet at the collision point (world clashMidX + clashPush, mapped
// through CAM so the energy ball slides as the push shifts), a big crackling energy
// BALL at the meeting point, a tug-of-war bar (clashMash0 vs clashMash1), and a
// flashing MASH! prompt. Uses assets/fx/clash.png as the ball art when present (img()
// gives it an _ok/_failed state like the other images), else a fully procedural
// additive ball + tapering beams. On 'clashResolve' a winner burst expands and the
// cinematic ends. Screen-space (identity ctx) - matches drawUltimateCinematic. No
// per-frame array/object/closure allocations, no Math.random/Date.now: all motion is
// derived from cf.tt and core's clash* fields.
// ---------------------------------------------------------------------------
const CLASH_CRACKLE = 7;    // radiating crackle spokes (looped by index, no array alloc)
const CLASH_BEAM_THICK = 118; // clash beam-art thickness in px (hero-scale, > the 96 of drawBeam)

// One side of the clash struggle: render THIS fighter's own themed ult_<fid>_beam ART,
// tinted its aura hex (getTintedCanvas is cached per hex in atlas.js), tiled from the
// fighter's on-screen muzzle (originX) toward the collision point (sx,sy), dir = +1 for
// P1 (left, points right) / -1 for P2 (right, points left) so the inner ends MEET at sx.
// Muzzle + impact poses drawn when present. FALLBACK: the original procedural tapering
// stroke-beam (edge -> sx) for a side whose beam pose is missing, so nothing breaks.
// Deterministic (frame / tt only); no per-frame allocation beyond the shared cached tint.
function drawClashBeamSide(ctx, ult, fid, hex, originX, sx, sy, dir, frame, tt) {
  const beamPose = 'ult_' + fid + '_beam';
  if (ult && atlasHasPose(ult, beamPose)) {
    const len = Math.max(0, dir > 0 ? (sx - originX) : (originX - sx));
    const scale = CLASH_BEAM_THICK / ult.cell.h;
    const segW = Math.max(8, ult.cell.w * scale);
    const dh = ult.cell.h * scale;
    const n = Math.min(64, Math.ceil(len / segW));
    // soft additive aura-hex glow underlay so the colour reads as emitted light.
    ctx.strokeStyle = rgba(hex, 0.22);
    ctx.lineCap = 'round';
    ctx.lineWidth = CLASH_BEAM_THICK * 0.85;
    ctx.beginPath(); ctx.moveTo(originX, sy); ctx.lineTo(sx, sy); ctx.stroke();
    for (let i = 0; i < n; i++) {
      const segX = originX + dir * (i * segW + segW * 0.5);
      drawPose(ctx, ult, beamPose, frame, segX, sy + dh / 2, { flip: dir < 0, scale, tint: hex });
    }
    const mpulse = scale * (1 + 0.15 * Math.sin(frame * 0.4));
    if (atlasHasPose(ult, 'ult_' + fid + '_muzzle')) drawPose(ctx, ult, 'ult_' + fid + '_muzzle', frame, originX, sy + dh / 2, { flip: dir < 0, scale: mpulse, tint: hex });
    if (atlasHasPose(ult, 'ult_' + fid + '_impact')) drawPose(ctx, ult, 'ult_' + fid + '_impact', frame, sx, sy + dh / 2, { flip: dir < 0, scale, tint: hex });
  } else {
    // fallback: original procedural tapering stroke-beam from the screen edge to (sx,sy).
    const pulse = 0.5 + 0.5 * Math.sin(tt * 0.35 + (dir < 0 ? Math.PI : 0));
    const edge = dir > 0 ? -20 : (W + 20);
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(hex, 0.5); ctx.lineWidth = 70 + 16 * pulse;
    ctx.beginPath(); ctx.moveTo(edge, sy); ctx.lineTo(sx, sy); ctx.stroke();
    ctx.strokeStyle = rgba(hex, 0.9); ctx.lineWidth = 30 + 8 * pulse;
    ctx.beginPath(); ctx.moveTo(edge, sy); ctx.lineTo(sx, sy); ctx.stroke();
  }
}

// v2.5 REACTION WINDOW prompt: during the short frozen beat after an ultimate is fired,
// call the responder to answer. Presentation-only; the countdown is read live from core's
// authoritative m.ultChallenge. A dramatic desat/vignette sells the slow-mo freeze.
function drawUltChallengePrompt(ctx, fx, m) {
  const respIdx = (fx.respSide || 1) - 1;
  const rf = m.fighters[respIdx];
  if (!rf) return;
  const frac = clamp01((m.ultChallenge || 0) / (fx.max || 1));
  const tt = fx.tt || 0;
  const rin = clamp01(tt / 8);           // quick fade-in over ~8 ticks

  // ---- dramatic slow-mo wash: dark vignette so the frozen beat reads ----
  ctx.save();
  ctx.fillStyle = `rgba(4,6,12,${0.34 * rin})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // responder position (feet -> above head), world FP mapped through CAM.
  const sx = W / 2 + (fpToPx(rf.x) - CAM.x) * CAM.zoom;
  const sy = H / 2 + (fpToPx(rf.y - 210000) - CAM.y) * CAM.zoom;

  // ---- pulsing callout over the responder ----
  const pulse = 1 + 0.10 * Math.sin(tt * 0.5);
  const blink = (tt % 24) < 16;          // deterministic blink from tt
  ctx.save();
  ctx.globalAlpha = rin;
  ctx.translate(sx, sy);
  ctx.scale(pulse, pulse);
  if (blink) chunkyText(ctx, t('ult_answer_prompt'), 0, -6, 30, GOLD);
  chunkyText(ctx, t('ult_answer_hint'), 0, 22, 15, '#EAF2FF');
  ctx.restore();

  // ---- shrinking reaction timer bar under the callout ----
  const bw = 260, bh = 12, bx = sx - bw / 2, by = sy + 40;
  ctx.save();
  ctx.globalAlpha = rin;
  ctx.fillStyle = 'rgba(8,10,16,0.85)';
  ctx.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
  // colour shifts gold -> red as time runs out
  const barHex = frac > 0.4 ? GOLD : '#FF4D4D';
  ctx.fillStyle = rgba(barHex, 0.95);
  ctx.fillRect(bx, by, bw * frac, bh);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
  ctx.strokeRect(bx - 3, by - 3, bw + 6, bh + 6);
  ctx.restore();
}

function drawClashCinematic(ctx, cf, m) {
  const tt = cf.tt;
  const resolving = cf.resolveTt >= 0;

  // collision point in WORLD px (slides with clashPush), mapped to screen through CAM;
  // frozen at the stored collision point (cf.cx) once resolving / if fields are absent.
  const clashing = !!m.clashActive;
  let worldX = clashing ? fpToPx((m.clashMidX || 0) + (m.clashPush || 0)) : 0;
  if (!worldX) worldX = cf.cx || CAM.x;
  const worldY = cf.cy || (CAM_FLOOR_Y - 170);
  const sx = W / 2 + (worldX - CAM.x) * CAM.zoom;
  const sy = H / 2 + (worldY - CAM.y) * CAM.zoom;

  // per-fighter aura tints for the two beams / winner colours.
  const hex1 = currentFormAuraHex(state.p1Fighter, (m.fighters[0] && m.fighters[0].form) || 0);
  const hex2 = currentFormAuraHex(state.p2Fighter, (m.fighters[1] && m.fighters[1].form) || 0);

  // ---- letterbox bars + collision-centred vignette ----
  const barP = clamp01(tt / 12);
  const barH = 130 * easeOutBack(barP) * (barP > 0 ? 1 : 0);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, Math.max(0, barH));
  ctx.fillRect(0, H - Math.max(0, barH), W, Math.max(0, barH));
  const vg = ctx.createRadialGradient(sx, sy, H * 0.12, sx, sy, W * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // ---- two per-fighter beam struggles meeting at the collision point ----
  // Each side renders ITS OWN themed ult_<fid>_beam ART (tinted its aura hex) instead of a
  // generic line-beam - different colour AND different effect per fighter. The inner ends
  // both terminate at (sx,sy), which slides with clashPush, so the collision visibly shifts
  // toward whoever is losing the mash. Procedural stroke-beam fallback per side if a pose is
  // missing. fxUlt handle resolved exactly like drawBeam (state.fxUlt), kicked off if untried.
  if (state.fxUlt === undefined) ensureFxUltAtlas();
  const ult = state.fxUlt;
  const frame = m.frame || 0;
  const p1 = m.fighters[0], p2 = m.fighters[1];
  const CLASH_REACH = 46; // screen px in front of each fist (muzzle origin toward centre)
  const ox1 = W / 2 + (fpToPx((p1 && p1.x) || 0) - CAM.x) * CAM.zoom + CLASH_REACH;
  const ox2 = W / 2 + (fpToPx((p2 && p2.x) || 0) - CAM.x) * CAM.zoom - CLASH_REACH;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  drawClashBeamSide(ctx, ult, state.p1Fighter, hex1, ox1, sx, sy, 1, frame, tt);
  drawClashBeamSide(ctx, ult, state.p2Fighter, hex2, ox2, sx, sy, -1, frame, tt);
  ctx.restore();

  // ---- energy ball: clash.png art if present, else procedural additive ball ----
  const ballR = 96 + 20 * Math.sin(tt * 0.4);
  const cim = img('./assets/fx/clash.png');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (cim._ok) {
    const d = ballR * 3.2;
    ctx.translate(sx, sy);
    ctx.rotate(tt * 0.05);
    ctx.drawImage(cim, -d / 2, -d / 2, d, d);
  } else {
    const g = ctx.createRadialGradient(sx, sy, 4, sx, sy, ballR * 1.6);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, rgba(mixHex(hex1, hex2, 0.5), 0.8));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, ballR * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3;
    for (let i = 0; i < CLASH_CRACKLE; i++) {
      const a = (i / CLASH_CRACKLE) * Math.PI * 2 + tt * 0.08;
      const jag = ballR * (0.9 + 0.25 * Math.sin(tt * 0.7 + i * 2.3));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(a) * jag, sy + Math.sin(a) * jag);
      ctx.stroke();
    }
  }
  ctx.restore();

  // ---- tug-of-war bar (clashMash0 vs clashMash1; divider = who is mashing more) ----
  const c0 = m.clashMash0 || 0, c1 = m.clashMash1 || 0;
  const tot = c0 + c1;
  const frac = clamp01(tot > 0 ? c0 / tot : 0.5); // P1 (left) share
  const barW = 620, barBH = 26, barX = W / 2 - barW / 2, barY = Math.max(barH + 24, 118);
  const split = barW * frac;
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,16,0.85)';
  ctx.fillRect(barX - 3, barY - 3, barW + 6, barBH + 6);
  ctx.fillStyle = rgba(hex1, 0.9); ctx.fillRect(barX, barY, split, barBH);
  ctx.fillStyle = rgba(hex2, 0.9); ctx.fillRect(barX + split, barY, barW - split, barBH);
  ctx.fillStyle = '#fff'; ctx.fillRect(barX + split - 3, barY - 6, 6, barBH + 12);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 2;
  ctx.strokeRect(barX - 3, barY - 3, barW + 6, barBH + 6);
  ctx.restore();
  chunkyText(ctx, String(c0), barX + 22, barY + barBH / 2, 20, '#fff', 'left');
  chunkyText(ctx, String(c1), barX + barW - 22, barY + barBH / 2, 20, '#fff', 'right');
  chunkyText(ctx, t('fn_' + state.p1Fighter), barX - 14, barY + barBH / 2, 16, hex1, 'right');
  chunkyText(ctx, t('fn_' + state.p2Fighter), barX + barW + 14, barY + barBH / 2, 16, hex2, 'left');

  // ---- flashing SMASH! prompt + button hint (blinks + throbs, deterministic from tt) ----
  if (!resolving && (tt % 30) < 18) {
    const mp = 1 + 0.12 * Math.sin(tt * 0.5);
    ctx.save();
    ctx.translate(sx, sy + ballR * 1.9 + 30);
    ctx.scale(mp, mp);
    chunkyText(ctx, t('clash_smash'), 0, 0, 40, GOLD);
    ctx.restore();
    // secondary hint (unscaled, steady) so players know WHAT to hammer
    chunkyText(ctx, t('clash_hint'), sx, sy + ballR * 1.9 + 66, 18, '#EAF2FF');
  }

  // ---- winner burst on resolve ----
  if (resolving) {
    const rp = clamp01(cf.resolveTt / 30);
    const wHex = cf.winner === 1 ? hex1 : cf.winner === 2 ? hex2 : '#FFFFFF';
    const rr = 40 + rp * 340;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bg2 = ctx.createRadialGradient(sx, sy, 2, sx, sy, rr);
    bg2.addColorStop(0, rgba('#FFFFFF', 0.9 * (1 - rp)));
    bg2.addColorStop(0.5, rgba(wHex, 0.7 * (1 - rp)));
    bg2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg2;
    ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (cf.winner === 1 || cf.winner === 2) {
      chunkyText(ctx, t('fn_' + (cf.winner === 1 ? state.p1Fighter : state.p2Fighter)), sx, sy - rr * 0.3, 46, wHex);
    }
  }

  ctx.restore();
}

let lastClatterTick = -999;
function drawUltimateCinematic(ctx, c) {
  const m = state.match;
  const fid = c.fid;
  const form = (m && m.fighters[c.side - 1] && m.fighters[c.side - 1].form) || 0;
  const hex = currentFormAuraHex(fid, form);
  const fromLeft = c.side === 1;
  const tt = c.tt;

  // letterbox bars sliding in over the first ~15 ticks
  const barP = clamp01(tt / 15);
  const barH = 140 * easeOutBack(barP) * (barP > 0 ? 1 : 0);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, Math.max(0, barH));
  ctx.fillRect(0, H - Math.max(0, barH), W, Math.max(0, barH));

  // dark vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.7);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // pulsing aura-colored glow behind the portrait
  const pulse = 0.5 + 0.5 * Math.sin(tt / 6);
  const cx = fromLeft ? W * 0.32 : W * 0.68;
  const cy = H * 0.5;
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 360);
  glow.addColorStop(0, rgba(hex, 0.55 * pulse + 0.15));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // procedural radiating speed lines
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(cx, cy);
  ctx.rotate(tt * 0.01);
  const lines = 18;
  for (let i = 0; i < lines; i++) {
    const ang = (i / lines) * Math.PI * 2;
    const len = 260 + (i % 3) * 60;
    ctx.strokeStyle = rgba(hex, 0.22);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * 90, Math.sin(ang) * 90);
    ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.restore();

  // portrait slide/zoom in from the side over ticks ~10-40
  const slideP = clamp01((tt - 10) / 30);
  const e = easeOutBack(slideP);
  const pw = 460, ph = 620;
  const targetX = cx;
  const startX = fromLeft ? -pw : W + pw;
  const px = lerp(startX, targetX, e);
  const im = img('./assets/portraits/' + fid + '.png');
  ctx.save();
  ctx.strokeStyle = rgba(hex, 0.8);
  ctx.lineWidth = 6;
  if (im._ok) {
    ctx.drawImage(im, px - pw / 2, cy - ph / 2, pw, ph);
    ctx.strokeRect(px - pw / 2, cy - ph / 2, pw, ph);
  } else {
    drawFighterFallback(ctx, fid, px, cy + ph * 0.3, { scale: 3.4 });
  }
  ctx.restore();

  // v2.4 "grow big big BOOM" (Image-1): a growing energy orb at the fighter's hand that
  // scales up across the 90-tick freeze, blooming into a muzzle flash near the end. Pure
  // procedural (aura hex = the function's own `hex` from currentFormAuraHex - the glow
  // follows the form, the art body is never tinted). Deterministic from `tt`, additive.
  {
    const handX = px + (fromLeft ? 1 : -1) * pw * 0.30;
    const handY = cy - ph * 0.02;
    const growP = clamp01(tt / 78);            // accelerating build across the freeze
    const orbR = 6 + growP * growP * 74;       // 6 -> 80px
    const boomP = clamp01((tt - 66) / 14);     // final bloom into a muzzle flash
    const finalR = orbR * (1 + boomP * 2.2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // outer aura-hex wash
    const gAura = ctx.createRadialGradient(handX, handY, finalR * 0.1, handX, handY, finalR * 1.4);
    gAura.addColorStop(0, rgba(hex, 0.6));
    gAura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gAura;
    ctx.beginPath(); ctx.arc(handX, handY, finalR * 1.4, 0, Math.PI * 2); ctx.fill();
    // brighter aura/white mid layer
    const gMid = ctx.createRadialGradient(handX, handY, 2, handX, handY, finalR);
    gMid.addColorStop(0, 'rgba(255,255,255,0.95)');
    gMid.addColorStop(0.45, rgba(hex, 0.85));
    gMid.addColorStop(1, rgba(hex, 0));
    ctx.fillStyle = gMid;
    ctx.beginPath(); ctx.arc(handX, handY, finalR, 0, Math.PI * 2); ctx.fill();
    // white-hot core
    const gCore = ctx.createRadialGradient(handX, handY, 0, handX, handY, finalR * 0.42);
    gCore.addColorStop(0, 'rgba(255,255,255,1)');
    gCore.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gCore;
    ctx.beginPath(); ctx.arc(handX, handY, finalR * 0.42, 0, Math.PI * 2); ctx.fill();
    // a few deterministic orbiting sparks (no Math.random - render-only, but kept clean)
    const sparks = 5;
    const orbit = orbR * 1.5;
    for (let i = 0; i < sparks; i++) {
      const ang = (i / sparks) * Math.PI * 2 + tt * 0.12;
      const sxp = handX + Math.cos(ang) * orbit;
      const syp = handY + Math.sin(ang) * orbit;
      const sr = 4 + 3 * Math.sin(tt * 0.3 + i);
      ctx.fillStyle = rgba(hex, 0.9);
      ctx.beginPath(); ctx.arc(sxp, syp, Math.max(1.5, sr), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  chunkyText(ctx, t('fn_' + fid), cx, cy + ph * 0.42, 34, '#fff');

  // EDISON SPECIAL: laptop graphic + upward code rain + keyboard-clatter sfx
  if (c.edison) {
    drawEdisonLaptopCinematic(ctx, fromLeft ? W * 0.68 : W * 0.32, cy, tt);
    if (tt > 15 && tt < 78 && tt - lastClatterTick >= 4) {
      lastClatterTick = tt;
      audio.sfx('sfx_hit_l', 0.08);
    }
  }

  ctx.restore();
}

// simple procedural pixel-art-ish laptop with green code characters raining upward
const CODE_CHARS = ['0', '1', '{', '}', ';', '<', '>', '/', '$', '#'];
function drawEdisonLaptopCinematic(ctx, x, y, tt) {
  const lw = 220, lh = 150;
  ctx.save();
  ctx.translate(x, y + 40);
  // base
  ctx.fillStyle = '#1c1f26';
  ctx.fillRect(-lw / 2 - 16, lh * 0.42, lw + 32, 14);
  // screen
  ctx.fillStyle = '#12151b';
  ctx.fillRect(-lw / 2, -lh / 2, lw, lh * 0.92);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 3;
  ctx.strokeRect(-lw / 2, -lh / 2, lw, lh * 0.92);
  // screen glow
  ctx.fillStyle = 'rgba(56, 226, 122, 0.12)';
  ctx.fillRect(-lw / 2 + 4, -lh / 2 + 4, lw - 8, lh * 0.92 - 8);
  ctx.restore();

  // code rain, columns of characters drifting upward and looping
  ctx.save();
  ctx.font = '900 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(56,226,122,0.9)';
  const cols = 7;
  for (let c = 0; c < cols; c++) {
    const cxp = x - lw / 2 + 14 + c * ((lw - 28) / (cols - 1));
    for (let r = 0; r < 5; r++) {
      const phase = (tt * 3 + c * 17 + r * 29) % 120;
      const cy2 = y + lh * 0.4 - phase;
      if (cy2 < y - lh * 0.55 || cy2 > y + lh * 0.42) continue;
      const ch = CODE_CHARS[(c * 5 + r + ((tt / 6) | 0)) % CODE_CHARS.length];
      ctx.globalAlpha = clamp01((cy2 - (y - lh * 0.55)) / (lh * 0.3));
      ctx.fillText(ch, cxp, cy2);
    }
  }
  ctx.restore();
}

function drawPauseOverlay(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, W, H);
  chunkyText(ctx, t('pause_title'), W / 2, H * 0.32, 70, '#fff');
  const items = [t('pause_resume'), t('pause_options'), t('pause_quit')];
  items.forEach((label, i) => {
    const y = H * 0.48 + i * 80;
    const active = state.pauseIndex === i;
    ctx.fillStyle = active ? 'rgba(22,199,228,0.18)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(W / 2 - 260, y - 34, 520, 68);
    chunkyText(ctx, label, W / 2, y, 34, active ? CYAN : '#fff');
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// v2.1 PRACTICE / overlay draw layer (all screen-space, identity transform).
// ---------------------------------------------------------------------------

// One input token: a translucent ring lit when its bit is held, with a vector
// glyph (PS shape or direction arrow) inside. Module-level (no per-frame closures).
function drawInputToken(ctx, cx, cy, r, pressed, color, shape) {
  ctx.save();
  ctx.globalAlpha = pressed ? 1 : 0.3;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.fillStyle = pressed ? rgba(color, 0.35) : 'rgba(255,255,255,0.04)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  const s = r * 0.5;
  ctx.beginPath();
  if (shape === 'square') { ctx.rect(cx - s, cy - s, s * 2, s * 2); ctx.stroke(); }
  else if (shape === 'triangle') { ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy + s); ctx.lineTo(cx - s, cy + s); ctx.closePath(); ctx.stroke(); }
  else if (shape === 'circle') { ctx.arc(cx, cy, s, 0, Math.PI * 2); ctx.stroke(); }
  else if (shape === 'cross') { ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s); ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s); ctx.stroke(); }
  else if (shape === 'flame') { ctx.arc(cx, cy, s * 0.85, 0, Math.PI * 2); ctx.fillStyle = color; ctx.globalAlpha = pressed ? 0.9 : 0.35; ctx.fill(); }
  else if (shape === 'up') { ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy + s * 0.6); ctx.lineTo(cx - s, cy + s * 0.6); ctx.closePath(); ctx.stroke(); }
  else if (shape === 'down') { ctx.moveTo(cx, cy + s); ctx.lineTo(cx + s, cy - s * 0.6); ctx.lineTo(cx - s, cy - s * 0.6); ctx.closePath(); ctx.stroke(); }
  else if (shape === 'left') { ctx.moveTo(cx - s, cy); ctx.lineTo(cx + s * 0.6, cy + s); ctx.lineTo(cx + s * 0.6, cy - s); ctx.closePath(); ctx.stroke(); }
  else if (shape === 'right') { ctx.moveTo(cx + s, cy); ctx.lineTo(cx - s * 0.6, cy + s); ctx.lineTo(cx - s * 0.6, cy - s); ctx.closePath(); ctx.stroke(); }
  ctx.restore();
}

// A horizontal strip of the current input mask: directions (cyan) then the PS
// face buttons (square/triangle/circle/cross) + POWER flame, each lit when held.
function drawInputDisplay(ctx, x, y, mask) {
  const r = 15, step = r * 2 + 6;
  let cx = x + r;
  drawInputToken(ctx, cx, y, r, (mask & BIT.LEFT) !== 0, CYAN, 'left'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.RIGHT) !== 0, CYAN, 'right'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.UP) !== 0, CYAN, 'up'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.DOWN) !== 0, CYAN, 'down'); cx += step + 8;
  drawInputToken(ctx, cx, y, r, (mask & BIT.LIGHT) !== 0, '#C5CDFF', 'square'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.HEAVY) !== 0, '#38E27A', 'triangle'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.BLAST) !== 0, '#FF7896', 'circle'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.DASH) !== 0, '#F26419', 'cross'); cx += step;
  drawInputToken(ctx, cx, y, r, (mask & BIT.POWER) !== 0, GOLD, 'flame');
}

// Combo-list reference card (right side) - the fighter's chain lengths + the
// verb reminders, shown while the practice "COMBO LIST CARD" toggle is on.
function drawComboListCard(ctx, fid) {
  const F = FIGHTERS && FIGHTERS[fid];
  const lightLen = (F && F.comboLight && F.comboLight.length) || 0;
  const heavyLen = (F && F.comboHeavy && F.comboHeavy.length) || 0;
  const cardW = 560, cardX = W - cardW - 40, cardY = 224, cardH = 300;
  ctx.save();
  ctx.fillStyle = 'rgba(10,12,18,0.82)';
  ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.strokeStyle = rgba(CYAN, 0.4);
  ctx.lineWidth = 2;
  ctx.strokeRect(cardX, cardY, cardW, cardH);
  let ly = cardY + 34;
  chunkyText(ctx, t('practice_show_combolist'), cardX + 24, ly, 22, CYAN, 'left'); ly += 40;
  chunkyText(ctx, t('practice_combolist_light') + ': ' + lightLen + ' ' + t('practice_combolist_hits_suffix'), cardX + 24, ly, 18, '#fff', 'left'); ly += 30;
  chunkyText(ctx, t('practice_combolist_heavy') + ': ' + heavyLen + ' ' + t('practice_combolist_hits_suffix'), cardX + 24, ly, 18, '#fff', 'left'); ly += 36;
  const reminders = ['practice_combolist_reminder1', 'practice_combolist_reminder2', 'practice_combolist_reminder3', 'practice_combolist_reminder4'];
  for (let i = 0; i < reminders.length; i++) {
    chunkyText(ctx, t(reminders[i]), cardX + 24, ly, 14, 'rgba(255,255,255,0.7)', 'left');
    ly += 26;
  }
  ctx.restore();
}

// Trainer HUD - the live combo hits / total + last damage / input strip, plus the
// optional combo-list card. Screen-space, drawn under the top health bars.
function drawPracticeHud(ctx, m) {
  const ps = state.practiceSettings;
  // v2.2: nudged down so the redesigned HUD (portrait/bars/combo ~y190) never overlaps.
  const panelX = 40, panelY = 224, panelW = 380, panelH = 240;
  ctx.save();
  ctx.fillStyle = 'rgba(10,12,18,0.78)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = rgba(GOLD, 0.35);
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  let ry = panelY + 30;
  chunkyText(ctx, t('practice_dummy_label') + ': ' + t('practice_dummy_' + ps.dummy), panelX + 20, ry, 18, GOLD, 'left'); ry += 40;

  const combo = (m.fighters[0] && m.fighters[0].combo) || 0;
  chunkyText(ctx, t('practice_hud_combo'), panelX + 20, ry, 16, 'rgba(255,255,255,0.6)', 'left');
  chunkyText(ctx, String(combo), panelX + panelW - 20, ry, 22, '#fff', 'right'); ry += 34;

  chunkyText(ctx, t('practice_hud_total_dmg'), panelX + 20, ry, 16, 'rgba(255,255,255,0.6)', 'left');
  chunkyText(ctx, String(state.practiceStats.totalDmg | 0), panelX + panelW - 20, ry, 22, '#38E27A', 'right'); ry += 34;

  chunkyText(ctx, t('practice_hud_last_dmg'), panelX + 20, ry, 16, 'rgba(255,255,255,0.6)', 'left');
  chunkyText(ctx, String(state.practiceStats.lastDmg | 0), panelX + panelW - 20, ry, 22, '#F2C230', 'right'); ry += 34;

  chunkyText(ctx, t('practice_hud_input'), panelX + 20, ry, 16, 'rgba(255,255,255,0.6)', 'left'); ry += 26;
  drawInputDisplay(ctx, panelX + 16, ry + 4, state.practiceStats.lastInput);
  ctx.restore();

  if (ps.showCombolist) drawComboListCard(ctx, state.p1Fighter);
}

function practiceRowLabel(row) {
  return {
    dummy: 'practice_dummy_label', refillHp: 'practice_refill_hp', refillKi: 'practice_refill_ki',
    refillMeter: 'practice_refill_meter', showCombolist: 'practice_show_combolist',
    reset: 'practice_reset', resume: 'pause_resume', quit: 'pause_quit',
  }[row];
}
function practiceRowValue(row) {
  const ps = state.practiceSettings;
  if (row === 'dummy') return t('practice_dummy_' + ps.dummy);
  if (row === 'refillHp') return t(ps.refillHp ? 'val_on' : 'val_off');
  if (row === 'refillKi') return t(ps.refillKi ? 'val_on' : 'val_off');
  if (row === 'refillMeter') return t(ps.refillMeter ? 'val_on' : 'val_off');
  if (row === 'showCombolist') return t(ps.showCombolist ? 'val_on' : 'val_off');
  return '';
}
function drawPracticePanel(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, W, H);
  chunkyText(ctx, t('practice_panel_title'), W / 2, 150, 56, GOLD);
  const rowH = 74, startY = 260;
  PRACTICE_ROWS.forEach((row, i) => {
    const y = startY + i * rowH;
    const active = state.practiceIndex === i;
    ctx.fillStyle = active ? 'rgba(255,210,74,0.14)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(W * 0.22, y - 28, W * 0.56, 56);
    chunkyText(ctx, t(practiceRowLabel(row)), W * 0.26, y, 24, active ? GOLD : '#fff', 'left');
    const val = practiceRowValue(row);
    if (val) chunkyText(ctx, val, W * 0.74, y, 24, active ? GOLD : '#fff', 'right');
  });
  ctx.restore();
}

// In-fight how-to overlay (the "?" button). Offline it sits over a frozen sim;
// online the sim keeps stepping behind it. Content = the PS-scheme how-to strings.
const HOW_OVERLAY_LEFT = ['how_kb_p1', 'how_kb_p1_move', 'how_kb_p1_atk', 'how_kb_p1_atk2', 'how_touch', 'how_touch_desc'];
const HOW_OVERLAY_RIGHT = ['how_movelist_header', 'how_chain', 'how_blast', 'how_blast2', 'how_dash', 'how_super', 'how_throw', 'how_power', 'how_block'];
function drawHowOverlay(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(6,8,12,0.9)';
  // full-bleed dim: the stage art intentionally bleeds past the 1920x1080 virtual
  // frame into the letterbox margins, so the dim must overshoot too.
  ctx.fillRect(-W, -H, W * 3, H * 3);
  chunkyText(ctx, t('how_title'), W / 2, 90, 48, CYAN);

  // word-wrap long body lines inside their column (overlay-only path, not hot)
  const colW = W * 0.44;
  const wrap = (str, size) => {
    ctx.font = `900 ${size}px Arial, sans-serif`;
    const words = String(str).split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const probe = line ? line + ' ' + w : w;
      if (line && ctx.measureText(probe).width > colW) { lines.push(line); line = w; }
      else line = probe;
    }
    if (line) lines.push(line);
    return lines;
  };
  const drawCol = (keys, x) => {
    let y = 180;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const header = HOW_HEADERS.has(k);
      const size = header ? 22 : 17;
      const lines = header ? [t(k)] : wrap(t(k), size);
      for (const ln of lines) {
        chunkyText(ctx, ln, x, y, size, header ? CYAN : '#fff', 'left');
        y += header ? 40 : 30;
      }
    }
  };
  drawCol(HOW_OVERLAY_LEFT, W * 0.06);
  drawCol(HOW_OVERLAY_RIGHT, W * 0.52);
  chunkyText(ctx, t('how_resume_hint'), W / 2, H - 60, 22, GOLD);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// v2.1 touch DOM: screens.js owns showing/hiding the "?" tutorial button (per
// fight screen) and the ULTIMATE pop-up button (only at full local meter, tinted
// in the fighter's aura color). Cached so we only touch the DOM on a real change.
// ---------------------------------------------------------------------------
const ultBtnEl = (typeof document !== 'undefined') ? document.getElementById('ng-btn-ultimate') : null;
const tutorialBtnEl = (typeof document !== 'undefined') ? document.getElementById('ng-tutorial-btn') : null;
// v2.5 online lobby: copy the room invite link to the clipboard (host waiting screen).
const copyBtnEl = (typeof document !== 'undefined') ? document.getElementById('ng-copy') : null;
if (copyBtnEl) copyBtnEl.addEventListener('click', () => {
  const done = () => { state.toast = { text: t('online_link_copied'), until: 120 }; };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done, done);
    else done();
  } catch (_e) { done(); }
});
function updateTouchDom() {
  const showTut = state.screen === 'fight';
  if (showTut !== state.domTutShown) {
    state.domTutShown = showTut;
    if (tutorialBtnEl) tutorialBtnEl.classList.toggle('show', showTut);
  }

  let ready = false, hex = '';
  if (state.screen === 'fight' && state.match && !state.paused && !state.howOverlayOpen && !state.cinematic
      && !(state.mode === 'online' && state.netSeat === 0)) {
    const localIdx = (state.mode === 'online' && state.netSeat === 2) ? 1 : 0;
    const f = state.match.fighters[localIdx];
    if (f && (f.meter || 0) >= 100) {
      ready = true;
      const fid = localIdx === 0 ? state.p1Fighter : state.p2Fighter;
      hex = currentFormAuraHex(fid, f.form || 0);
    }
  }
  if (ready !== state.domUltReady) {
    state.domUltReady = ready;
    if (ultBtnEl) ultBtnEl.classList.toggle('ready', ready);
  }
  if (ready && hex && hex !== state.domUltHex) {
    state.domUltHex = hex;
    if (ultBtnEl) {
      ultBtnEl.style.borderColor = hex;
      ultBtnEl.style.color = hex;
      ultBtnEl.style.boxShadow = '0 0 18px 4px ' + rgba(hex, 0.6);
    }
  }
}

// v2.1 DYNAMIC CAMERA - lerps the single reused CAM toward a framing target that
// keeps both fighters + a margin in view, anchors their feet at ~86% frame height,
// and follows a fighter up on a double jump. Mutates CAM in place (zero alloc).
function updateCamera(m) {
  const f0 = m.fighters[0], f1 = m.fighters[1];
  if (!f0 || !f1) return;
  const x0 = fpToPx(f0.x), x1 = fpToPx(f1.x);
  const y0 = fpToPx(f0.y), y1 = fpToPx(f1.y);

  // horizontal: fit the gap between fighters + a margin each side, clamped so the
  // visible width stays in [min,max] world px -> that ratio IS the zoom.
  let visW = Math.abs(x0 - x1) + CAM_MARGIN * 2;
  if (visW < CAM_MIN_VIS_W) visW = CAM_MIN_VIS_W;
  else if (visW > CAM_MAX_VIS_W) visW = CAM_MAX_VIS_W;
  const zoom = W / visW;

  let tx = (x0 + x1) * 0.5;
  // feet anchor: choose cam.y so the floor line maps to CAM_FEET_FRAC of the frame.
  let ty = CAM_FLOOR_Y - (CAM_FEET_FRAC * H - H / 2) / zoom;

  // vertical follow: pan up once the higher fighter rises past the threshold.
  const topY = Math.min(y0, y1);
  const airborne = CAM_FLOOR_Y - topY;
  if (airborne > CAM_AIR_THRESHOLD) {
    ty -= Math.min(airborne - CAM_AIR_THRESHOLD, CAM_AIR_MAX) * 0.55;
  }

  // keep the visible window inside the 1920x1080 arena bounds.
  const halfW = (W / zoom) * 0.5;
  const halfH = (H / zoom) * 0.5;
  if (tx < halfW) tx = halfW; else if (tx > W - halfW) tx = W - halfW;
  if (ty < halfH) ty = halfH; else if (ty > H - halfH) ty = H - halfH;

  if (state.camSnap) {
    CAM.x = tx; CAM.y = ty; CAM.zoom = zoom;
    state.camSnap = false;
  } else {
    CAM.x += (tx - CAM.x) * CAM_LERP;
    CAM.y += (ty - CAM.y) * CAM_LERP;
    CAM.zoom += (zoom - CAM.zoom) * CAM_LERP;
  }
}

// world->screen for the floor plane: screen = worldCenter + (world - cam) * zoom,
// matching exactly how vfx.js / stages.js's floor band map their coordinates.
function applyCam(ctx, cam) {
  ctx.translate(W / 2, H / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
}

function drawFight(ctx) {
  const m = state.match;
  if (!m) { bg(ctx, DARK); return; }

  updateCamera(m); // per-render-frame ease toward the framing target

  const off = (feel.offset && feel.offset()) || { x: 0, y: 0 };
  ctx.save();
  ctx.translate(off.x || 0, off.y || 0); // feel shake wraps the whole world (screen space)

  // stage bg applies CAM itself (per-band parallax zoom); ctx stays in world space.
  if (state.stageId) stageRt.draw(ctx, CAM, 'bg');
  else bg(ctx, DARK);

  // fighters / aura / projectiles / summons live on the floor plane - wrap them in
  // the SAME camera transform that vfx.js and stages.js's floor band apply.
  ctx.save();
  applyCam(ctx, CAM);
  drawFighter(ctx, 1, state.p1Fighter, m.fighters[0]);
  drawFighter(ctx, 2, state.p2Fighter, m.fighters[1]);
  // v2: charge/transform aura flames + sparks (our own pooled layer), additive.
  drawAuraParticles(ctx);
  drawEntities(ctx, m.projectiles, 'proj');
  drawBeamWindows(ctx);
  drawEntities(ctx, m.summons, 'summon');
  drawBlastImpacts(ctx); // v2.4: one-shot ki-blast boom bursts, same world-space plane
  ctx.restore();

  // vfx applies CAM itself from the object; keep it OUTSIDE the applyCam wrap.
  vfx.draw(ctx, CAM);
  if (state.stageId) stageRt.draw(ctx, CAM, 'fg');

  ctx.restore();

  // ---- screen-space (identity) layers: HUD, splashes, cinematic, overlays ----
  drawTransformDim(ctx);

  drawHud(ctx, m);
  if (state.mode === 'practice') drawPracticeHud(ctx, m);

  if (state.roundSplash) drawRoundSplash(ctx, state.roundSplash);
  if (state.roundEndSplash) drawRoundEndSplash(ctx, state.roundEndSplash);
  if (state.formSplash) drawFormSplash(ctx, state.formSplash);

  // v2.3: the ultimate-CLASH cinematic takes over while a clash is active (and for its
  // short resolve tail), and the singleton per-fighter super cinematic is suppressed so
  // the two colliding supers cannot clobber each other or the clash.
  const clashOn = !!(m && m.clashActive) || !!state.clashFx;
  if (state.clashFx) drawClashCinematic(ctx, state.clashFx, m);
  // v2.5 reaction-window prompt: only during the window, and it yields to a clash.
  if (state.ultChallengeFx && m && m.ultChallenge > 0 && !clashOn) drawUltChallengePrompt(ctx, state.ultChallengeFx, m);
  if (state.cinematic && !clashOn) drawUltimateCinematic(ctx, state.cinematic);

  if (feel.apply) feel.apply(ctx);

  if (state.paused) {
    if (state.mode === 'practice') drawPracticePanel(ctx);
    else drawPauseOverlay(ctx);
  }
  if (state.howOverlayOpen) drawHowOverlay(ctx);
}

// ---------------------------------------------------------------------------
// RESULT
// ---------------------------------------------------------------------------
function resultOptions() {
  const m = state.match;
  const wonP1 = m ? m.wins[0] >= m.wins[1] : true;
  const opts = [];
  if (state.mode === 'arcade' && wonP1 && state.arcadeIndex < state.arcadeLadder.length - 1) {
    opts.push({ key: 'next', label: t('result_next_opponent') });
  } else {
    opts.push({ key: 'rematch', label: t('result_rematch') });
  }
  opts.push({ key: 'select', label: t('result_char_select') });
  if (!EMBED_DUEL) opts.push({ key: 'menu', label: t('result_menu') });
  return opts;
}
function resultAction(key) {
  if (key === 'next') {
    state.arcadeIndex++;
    state.p2Fighter = state.arcadeLadder[state.arcadeIndex];
    go('vs');
  } else if (key === 'rematch') {
    if (state.mode === 'online') {
      if (!state.localVotedRematch) {
        state.localVotedRematch = true;
        try { state.net.voteRematch(); } catch (e) { /* ignore */ }
      }
    } else {
      go('vs');
    }
  } else if (key === 'select') {
    go('select', { mode: state.mode });
  } else if (key === 'menu') {
    go('menu');
  }
}
function updateResult(cur) {
  const opts = resultOptions();
  if (edge(cur.local, state.prevLocal, BIT.UP)) state.resultIndex = (state.resultIndex + opts.length - 1) % opts.length;
  if (edge(cur.local, state.prevLocal, BIT.DOWN)) state.resultIndex = (state.resultIndex + 1) % opts.length;
  if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) {
    resultAction(opts[state.resultIndex].key);
  }
}
function drawResult(ctx) {
  bg(ctx, DARK);
  const m = state.match;
  const winner = (m && m.wins[0] >= m.wins[1]) ? 1 : 2;
  const wid = winner === 1 ? state.p1Fighter : state.p2Fighter;

  drawVsPortrait(ctx, wid, W / 2, H * 0.38, false);
  chunkyText(ctx, t('result_winner') + ': ' + t('fn_' + wid), W / 2, H * 0.62, 44, GOLD);
  chunkyText(ctx, t('wq_' + wid), W / 2, H * 0.70, 24, '#fff');

  const opts = resultOptions();
  opts.forEach((o, i) => {
    const y = H * 0.80 + i * 56;
    const active = state.resultIndex === i;
    chunkyText(ctx, o.label, W / 2, y, 28, active ? CYAN : '#fff');
  });

  if (state.mode === 'online') {
    const v = state.rematchVotes || { p1: false, p2: false };
    const count = (v.p1 ? 1 : 0) + (v.p2 ? 1 : 0);
    chunkyText(ctx, t('result_votes') + ': ' + count + '/2', W / 2, H * 0.94, 18, 'rgba(255,255,255,0.6)');
  }
}

// ---------------------------------------------------------------------------
// OPTIONS
// ---------------------------------------------------------------------------
function confirmOptionsBack() {
  if (state.optionsReturnScreen === 'fight') {
    state.screen = 'fight';
    updateShareButton();
  } else {
    go('menu');
  }
  state.optionsReturnScreen = 'menu';
}
function adjustOption(row, dir) {
  const o = state.opts;
  if (row === 'rounds') { const seq = [1, 3, 5]; let i = seq.indexOf(o.rounds); i = (i + dir + 3) % 3; o.rounds = seq[i]; }
  else if (row === 'musicVol') { o.musicVol = clamp01(o.musicVol + dir * 0.1); audio.setVol(o.musicVol, undefined); }
  else if (row === 'sfxVol') { o.sfxVol = clamp01(o.sfxVol + dir * 0.1); audio.setVol(undefined, o.sfxVol); }
  else if (row === 'cpuLevel') { o.cpuLevel = Math.min(3, Math.max(1, o.cpuLevel + dir)); }
  else if (row === 'shake') { o.shake = !o.shake; if (feel.setShakeEnabled) feel.setShakeEnabled(o.shake); }
  else if (row === 'flash') { o.flash = !o.flash; if (feel.setFlashEnabled) feel.setFlashEnabled(o.flash); }
  saveOpts(o);
}
function updateOptions(cur) {
  if (edge(cur.local, state.prevLocal, BIT.UP)) state.optionsIndex = (state.optionsIndex + OPT_ROWS.length - 1) % OPT_ROWS.length;
  if (edge(cur.local, state.prevLocal, BIT.DOWN)) state.optionsIndex = (state.optionsIndex + 1) % OPT_ROWS.length;
  const row = OPT_ROWS[state.optionsIndex];
  if (edge(cur.local, state.prevLocal, BIT.RIGHT)) adjustOption(row, 1);
  if (edge(cur.local, state.prevLocal, BIT.LEFT)) adjustOption(row, -1);
  if ((edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START)) && row === 'back') {
    confirmOptionsBack();
  }
  if (edge(cur.local, state.prevLocal, BIT.HEAVY)) confirmOptionsBack();
}
function optionRowLabel(row) {
  return {
    rounds: 'opt_rounds', musicVol: 'opt_music_vol', sfxVol: 'opt_sfx_vol',
    cpuLevel: 'opt_cpu_level', shake: 'opt_shake', flash: 'opt_flash', back: 'opt_back',
  }[row];
}
function optionRowValue(row) {
  const o = state.opts;
  if (row === 'rounds') return t('opt_bestof_prefix') + ' ' + o.rounds;
  if (row === 'musicVol') return Math.round(o.musicVol * 100) + '%';
  if (row === 'sfxVol') return Math.round(o.sfxVol * 100) + '%';
  if (row === 'cpuLevel') return t('val_cpu_' + o.cpuLevel);
  if (row === 'shake') return t(o.shake ? 'val_on' : 'val_off');
  if (row === 'flash') return t(o.flash ? 'val_on' : 'val_off');
  return '';
}
function drawOptions(ctx) {
  bg(ctx, DARK);
  chunkyText(ctx, t('options_title'), W / 2, 100, 56, CYAN);
  OPT_ROWS.forEach((row, i) => {
    const y = 240 + i * 90;
    const active = state.optionsIndex === i;
    ctx.fillStyle = active ? 'rgba(22,199,228,0.14)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(W * 0.2, y - 30, W * 0.6, 60);
    chunkyText(ctx, t(optionRowLabel(row)), W * 0.26, y, 26, active ? CYAN : '#fff', 'left');
    if (row !== 'back') chunkyText(ctx, optionRowValue(row), W * 0.74, y, 26, active ? CYAN : '#fff', 'right');
  });
}

// ---------------------------------------------------------------------------
// HOW TO PLAY
// ---------------------------------------------------------------------------
function updateHow(cur) {
  if (edge(cur.local, state.prevLocal, BIT.LIGHT) || edge(cur.local, state.prevLocal, BIT.START) || edge(cur.local, state.prevLocal, BIT.HEAVY)) {
    go('menu');
  }
}
const HOW_LEFT = ['how_controls_header', 'how_kb_p1', 'how_kb_p1_move', 'how_kb_p1_atk', 'how_kb_p2', 'how_kb_p2_move', 'how_kb_p2_atk', 'how_start', 'how_gamepad', 'how_gamepad_move', 'how_gamepad_atk', 'how_touch', 'how_touch_desc'];
const HOW_RIGHT = ['how_movelist_header', 'how_chain', 'how_special', 'how_signature', 'how_super', 'how_ultimate', 'how_power', 'how_throw', 'how_block', 'how_crouch_block'];
const HOW_HEADERS = new Set(['how_controls_header', 'how_kb_p1', 'how_kb_p2', 'how_gamepad', 'how_touch', 'how_movelist_header']);
function drawHow(ctx) {
  bg(ctx, DARK);
  chunkyText(ctx, t('how_title'), W / 2, 80, 50, CYAN);

  let y = 170;
  HOW_LEFT.forEach((k) => {
    const header = HOW_HEADERS.has(k);
    chunkyText(ctx, t(k), W * 0.06, y, header ? 24 : 19, header ? CYAN : '#fff', 'left');
    y += header ? 42 : 32;
  });

  let y2 = 170;
  HOW_RIGHT.forEach((k) => {
    const header = HOW_HEADERS.has(k);
    chunkyText(ctx, t(k), W * 0.54, y2, header ? 24 : 19, header ? CYAN : '#fff', 'left');
    y2 += header ? 42 : 34;
  });

  chunkyText(ctx, t('how_back'), W / 2, H - 60, 24, 'rgba(255,255,255,0.6)');
}

// ---------------------------------------------------------------------------
// NET (online mode) - net.js (final, on disk) API:
//   connectRoom({onSeat(msg), onSpectate(msg), onStart(msg), onInputs(seat,f,m),
//     onPeerHash(seat,f,h), onSync(seat,f,state), onRematch(votes), onPeer(event,seat),
//     onStatus(s), onError(code,msg)}) -> {sendInputs(frame,mask), sendHash(frame,h),
//     sendSync(frame,stateObj), sendCfg(fighterId,stageVote,roundsToWin), voteRematch(),
//     ping(), close(), status()}
// ---------------------------------------------------------------------------
function roundsToWinFromOpts() {
  return state.opts.rounds === 1 ? 1 : state.opts.rounds === 5 ? 3 : 2;
}

function sendNetCfg() {
  if (state.mode !== 'online' || !state.net) return;
  state.net.sendCfg(state.p1Fighter, state.stageId || undefined, roundsToWinFromOpts());
}

function onNetStart(seed, cfg) {
  state.netSeed = (seed >>> 0) || 0;
  if (cfg) {
    // server start cfg nests fighters as {p1:{fighterId}} per the protocol
    if (cfg.p1) state.p1Fighter = cfg.p1.fighterId || cfg.p1;
    if (cfg.p2) state.p2Fighter = cfg.p2.fighterId || cfg.p2;
    if (cfg.stageId) state.stageId = cfg.stageId;
    if (cfg.roundsToWin) state.opts.rounds = cfg.roundsToWin === 1 ? 1 : cfg.roundsToWin === 3 ? 5 : 3;
  }
  if (!state.p1Fighter) state.p1Fighter = ROSTER[0];
  if (!state.p2Fighter) state.p2Fighter = ROSTER[1];
  if (!state.stageId) state.stageId = 's1';
  go('vs');
}

function onNetInputs(seat, f, m) {
  if (seat !== state.netSeat && seat !== 0) state.remoteInputs.set(f, m);
}

function onNetPeerHash(seat, f, h) {
  const localHash = state.hashSentAt.get(f);
  if (localHash === undefined) return;
  if (localHash !== h) {
    state.hashMismatchStreak++;
    if (state.hashMismatchStreak >= 2 && state.netSeat === 1 && state.match) {
      try { state.net.sendSync(state.match.frame, serialize(state.match)); } catch (e) { /* ignore */ }
      state.hashMismatchStreak = 0;
    }
  } else {
    state.hashMismatchStreak = 0;
  }
}

function connectNet() {
  const params = new URLSearchParams(location.search);
  let roomId = params.get('room');
  if (!roomId) {
    roomId = Math.random().toString(36).slice(2, 8);
    params.set('room', roomId);
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  }
  state.roomId = roomId;

  let playerId = sessionStorage.getItem('ngarena.playerId');
  if (!playerId) {
    playerId = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('ngarena.playerId', playerId);
  }

  state.netStatus = 'connecting';
  state.net = connectRoom({
    roomId,
    playerId,
    onSeat: (msg) => { state.netSeat = msg.seat; updateShareButton(); },
    onSpectate: () => { state.netSeat = 0; updateShareButton(); },
    onStart: (msg) => onNetStart(msg.seed, msg.cfg),
    onInputs: (seat, f, m) => onNetInputs(seat, f, m),
    onPeerHash: (seat, f, h) => onNetPeerHash(seat, f, h),
    onSync: (seat, f, stateObj) => {
      try { state.match = deserialize(stateObj); state.hashMismatchStreak = 0; } catch (e) { /* ignore */ }
    },
    onRematch: (votes) => { state.rematchVotes = votes || state.rematchVotes; },
    onPeer: (event) => {
      if (event === 'leave') state.toast = { text: t('err_opponent_left'), until: 240 };
    },
    onStatus: (s) => { state.netStatus = s; },
    onError: () => {
      state.toast = { text: t('err_connect'), until: 180 };
      if (state.screen === 'select' || state.screen === 'stageSelect') go('menu');
    },
  });
}
function closeNet() {
  if (state.net) { try { state.net.close(); } catch (e) { /* ignore */ } }
  state.net = null;
  state.netSeat = 0;
  state.netStatus = 'idle';
  state.roomId = null;
  state.remoteInputs.clear();
  state.localScheduled.clear();
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------
function drawToast(ctx) {
  ctx.save();
  ctx.globalAlpha = Math.min(1, state.toast.until / 30);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  const w = 700, h = 60;
  ctx.fillRect(W / 2 - w / 2, H - 120, w, h);
  chunkyText(ctx, state.toast.text, W / 2, H - 90, 22, '#FF6B6B');
  ctx.restore();
}

// ---------------------------------------------------------------------------
// app export (contracts.md: export const app)
// ---------------------------------------------------------------------------
export const app = {
  state,
  go,
  update(cmds) {
    const cur = { local: (cmds && cmds.local) || 0, p2local: (cmds && cmds.p2local) || 0 };
    state.t++;

    switch (state.screen) {
      case 'boot': updateBoot(cur); break;
      case 'title': updateTitle(cur); break;
      case 'menu': updateMenu(cur); break;
      case 'select': updateSelect(cur); break;
      case 'stageSelect': updateStageSelect(cur); break;
      case 'vs': updateVs(cur); break;
      case 'fight': updateFight(cur); break;
      case 'result': updateResult(cur); break;
      case 'options': updateOptions(cur); break;
      case 'how': updateHow(cur); break;
      default: break;
    }

    if (state.toast) {
      state.toast.until--;
      if (state.toast.until <= 0) state.toast = null;
    }

    // v2.1: sync the touch DOM buttons ("?" tutorial + full-meter ULTIMATE pop-up).
    updateTouchDom();

    state.prevLocal = cur.local;
    state.prevP2local = cur.p2local;
  },
  draw(ctx) {
    switch (state.screen) {
      case 'boot': drawBoot(ctx); break;
      case 'title': drawTitle(ctx); break;
      case 'menu': drawMenu(ctx); break;
      case 'select': drawSelect(ctx); break;
      case 'stageSelect': drawStageSelect(ctx); break;
      case 'vs': drawVs(ctx); break;
      case 'fight': drawFight(ctx); break;
      case 'result': drawResult(ctx); break;
      case 'options': drawOptions(ctx); break;
      case 'how': drawHow(ctx); break;
      default: bg(ctx, DARK);
    }
    if (state.toast) drawToast(ctx);
  },
};
