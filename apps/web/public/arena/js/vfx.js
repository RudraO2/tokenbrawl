// js/vfx.js — particle/VFX system + game-feel (design/contracts.md pinned API):
//   export const vfx  = { spawn(name,x,y,{flip}), update(), draw(ctx,cam), clear() }
// v2.1: cam gains a .zoom field. Combat FX live at fighter/floor depth (spawned at
// fpToPx(hit x,y), same plane as the fighters screens.js draws with the full 1:1 camera),
// so draw() maps world->screen with the SAME formula screens.js uses for fighters:
// screen = worldCenter + (world - cam) * zoom - both position AND particle size scale by
// zoom so sparks/dust read consistently whether the camera is zoomed in tight or pulled back.
//   export const feel = { hitstop(frames), shake(mag,frames), flash(color,frames),
//     slowmo(factor,frames), update(), apply(ctx), offset(), timeScale() }
//
// Effect names: 'spark_l','spark_h','block','dust','ko_burst','trail','super_ring','confetti'.
// Every effect is sprite-sheet-driven when ./assets/atlas/fx.json (+ its sheet image) loads
// successfully; otherwise (before the art lands, or if it 404s) each effect has a procedural
// fallback: pooled additive glowy-pixel bursts in electric yellow #FFE94A, cyan #16C7E4 for
// the block spark, and chunky squares for the retro feel. Particle pool is preallocated at
// module load (POOL_CAP = 128, design/thresholds.md); update()/draw() never allocate.
import { loadAtlas, drawPose, poseContentMid } from './atlas.js';

const POOL_CAP = 128;
const YELLOW = '#FFE94A';
const CYAN = '#16C7E4';
const CONFETTI_PALETTE = ['#FFE94A', '#16C7E4', '#FFFFFF', '#FF6B4A'];

// ---- effect definitions (procedural fallback physics + look) ----
const EFFECTS = {
  spark_l: { count: 6, life: 10, speed: 3.5, size: 4, color: YELLOW, shape: 'square', gravity: 0, additive: true },
  spark_h: { count: 10, life: 14, speed: 5.2, size: 6, color: YELLOW, shape: 'square', gravity: 0.05, additive: true },
  block: { count: 8, life: 12, speed: 3.2, size: 4, color: CYAN, shape: 'square', gravity: 0, additive: true },
  dust: { count: 4, life: 20, speed: 1.1, size: 9, color: '#C9C9C9', shape: 'circle', gravity: -0.02, additive: false },
  ko_burst: { count: 26, life: 32, speed: 7.2, size: 8, color: '#FFF3B0', shape: 'square', gravity: 0.06, additive: true },
  // v2.3: size trimmed 30->16 - at 30 the dash streak drew ~340px tall vs a ~185px
  // fighter, so even mass-centroid-anchored (see vfx draw) its tail reached the head.
  trail: { count: 1, life: 8, speed: 0, size: 16, color: YELLOW, shape: 'ghost', gravity: 0, additive: false },
  // v2.2 whiff arc: matches the fx sheet's 'slash' pose 1:1 by name; spawned on every swing
  // so missed attacks still read as a visible strike arc. v2.3: trimmed 34->22 (same top-heavy fx).
  slash: { count: 1, life: 9, speed: 0, size: 22, color: '#FFFFFF', shape: 'ghost', gravity: 0, additive: true },
  super_ring: { count: 18, life: 22, speed: 6.2, size: 5, color: YELLOW, shape: 'ring', gravity: 0, additive: true },
  confetti: { count: 20, life: 42, speed: 4.2, size: 5, color: null, shape: 'square', gravity: 0.12, additive: false },
};

// ---- preallocated particle pool: plain objects, reused forever, never GC'd ----
function makeParticle() {
  return {
    active: false, kind: '', x: 0, y: 0, vx: 0, vy: 0, gravity: 0,
    age: 0, life: 1, size: 1, color: YELLOW, shape: 'square',
    rot: 0, vrot: 0, additive: false, flip: false,
  };
}
const POOL = new Array(POOL_CAP);
for (let i = 0; i < POOL_CAP; i++) POOL[i] = makeParticle();
let cursor = 0;

function acquire() {
  for (let i = 0; i < POOL_CAP; i++) {
    const idx = (cursor + i) % POOL_CAP;
    if (!POOL[idx].active) {
      cursor = (idx + 1) % POOL_CAP;
      return POOL[idx];
    }
  }
  return null; // pool full: drop the spawn silently (cap is a hard budget, not a suggestion)
}

// ---- optional fx spritesheet (assets/atlas/fx.json) — best-effort, non-blocking ----
let fxAtlas = null;
let fxAtlasFailed = false;
loadAtlas('./assets/atlas/fx.json').then((a) => { fxAtlas = a; }).catch(() => { fxAtlasFailed = true; });

// vfx effect name -> fx.json pose name, where they differ. 'dust' matches the sheet's
// 4-frame dissipating-cloud pose 1:1; 'trail' maps to the sheet's 'streak' pose (a horizontal
// speed-line flash used for dash/teleport afterimages). 'super_ring' and 'confetti' have no
// pose in the shipped fx sheet by design, so they always render via the procedural fallback.
const POSE_NAME_OVERRIDE = { trail: 'streak' };

function spawnOne(name, x, y, flip, def, color) {
  const p = acquire();
  if (!p) return;
  const ang = Math.random() * Math.PI * 2;
  const spd = def.speed * (0.5 + Math.random() * 0.7);
  p.active = true;
  p.kind = name;
  p.x = x;
  p.y = y;
  p.vx = Math.cos(ang) * spd;
  p.vy = Math.sin(ang) * spd;
  p.gravity = def.gravity;
  p.age = 0;
  p.life = def.life * (0.85 + Math.random() * 0.3);
  p.size = def.size * (0.8 + Math.random() * 0.4);
  p.color = color || def.color || CONFETTI_PALETTE[(Math.random() * CONFETTI_PALETTE.length) | 0];
  p.shape = def.shape;
  p.rot = Math.random() * Math.PI * 2;
  p.vrot = (Math.random() - 0.5) * 0.4;
  p.additive = def.additive;
  p.flip = !!flip;
}

export const vfx = {
  spawn(name, x, y, opts) {
    const def = EFFECTS[name];
    if (!def) return; // unknown effect name: silently ignore (mirrors atlas pose fallback spirit)
    const flip = opts && opts.flip;
    const color = opts && opts.color;   // optional per-spawn tint override (else def.color)
    if (name === 'trail') {
      // one soft after-image marker rather than a burst
      spawnOne(name, x, y, flip, def, color);
      return;
    }
    for (let i = 0; i < def.count; i++) spawnOne(name, x, y, flip, def, color);
  },

  update() {
    for (let i = 0; i < POOL_CAP; i++) {
      const p = POOL[i];
      if (!p.active) continue;
      p.age++;
      if (p.age >= p.life) { p.active = false; continue; }
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rot += p.vrot;
      if (p.shape === 'ring') {
        // radial expansion instead of straight-line drift
        p.vx *= 1.04;
        p.vy *= 1.04;
      }
    }
  },

  draw(ctx, cam) {
    const camX = (cam && cam.x) || 0;
    const camY = (cam && cam.y) || 0;
    const zoom = (cam && cam.zoom) || 1;
    const cx = 960, cy = 540; // world center (1920x1080 virtual canvas), matches screens.js
    for (let i = 0; i < POOL_CAP; i++) {
      const p = POOL[i];
      if (!p.active) continue;
      const sx = cx + (p.x - camX) * zoom;
      const sy = cy + (p.y - camY) * zoom;
      const fade = 1 - p.age / p.life;

      const poseName = POSE_NAME_OVERRIDE[p.kind] || p.kind;
      if (fxAtlas && fxAtlas.poses[poseName]) {
        const poseScale = (p.size / 32) * zoom;
        let drawY = sy;
        // 'streak' (trail after-image) and 'slash' (melee whiff arc) are LARGE, CENTERED
        // art, but drawPose is bottom-anchored - drawn at sy they tower ~185-280px UP into
        // the air (the old "fire on top of his head" dash artifact, the blast sky-streak,
        // and the melee "star at the banner"). Push them down by half the drawn height so
        // they sit ON the spawn point. (The small spark/dust/burst poses are size 4-9, so
        // their offset is negligible and reads as intended spread - left bottom-anchored.)
        if ((poseName === 'streak' || poseName === 'slash') && fxAtlas.cell) {
          // Center the pose's CONTENT (not the whole cell) on the spawn point. The
          // streak/slash art sits high inside its 208 cell, so cell-centering left it
          // ~cell/2 ABOVE the spawn ("streak on the head" during a dash). poseContentMid
          // measures the real content middle (px up from the cell bottom); fall back to
          // cell/2 only when the alpha read is unavailable (headless).
          const cmid = poseContentMid(fxAtlas, poseName);
          const fromBottom = (cmid == null) ? (fxAtlas.cell.h / 2) : cmid;
          drawY = sy + fromBottom * poseScale;
        }
        drawPose(ctx, fxAtlas, poseName, p.age, sx, drawY, { flip: p.flip, scale: poseScale, alpha: fade });
        continue;
      }
      drawProcedural(ctx, p, sx, sy, fade, zoom);
    }
  },

  clear() {
    for (let i = 0; i < POOL_CAP; i++) POOL[i].active = false;
  },
};

function drawProcedural(ctx, p, sx, sy, fade, zoom) {
  const z = zoom || 1;
  const size = p.size * z;
  ctx.save();
  ctx.globalCompositeOperation = p.additive ? 'lighter' : 'source-over';
  ctx.globalAlpha = Math.max(0, Math.min(1, fade));
  ctx.fillStyle = p.color;
  ctx.strokeStyle = p.color;

  switch (p.shape) {
    case 'circle':
      ctx.beginPath();
      ctx.arc(sx, sy, size * (0.6 + (1 - fade) * 0.8), 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'ring': {
      const r = size * (1 + (1 - fade) * 5);
      ctx.lineWidth = Math.max(1, size * 0.4);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'ghost': {
      const dirX = p.flip ? 1 : -1;
      ctx.translate(sx, sy);
      ctx.fillRect(dirX * size * -0.5, -size * 0.5, size, size);
      break;
    }
    case 'square':
    default:
      ctx.translate(sx, sy);
      ctx.rotate(p.rot);
      ctx.fillRect(-size / 2, -size / 2, size, size);
      break;
  }
  ctx.restore();
}

// -------------------------------------------------------------------------------------
// feel: hitstop / screen shake / flash / slowmo — the main loop drives these once per
// RENDERED frame (not per sim tick) via update(), then reads timeScale()/hitstopActive()
// to decide how many sim ticks to run, and offset()/apply(ctx) while rendering.
// -------------------------------------------------------------------------------------
const feelState = {
  hitstopFrames: 0,
  shakeFrames: 0, shakeTotal: 0, shakeMag: 0,
  flashFrames: 0, flashTotal: 0, flashColor: null,
  slowmoFrames: 0, slowmoFactor: 1,
  shakeEnabled: true,
  flashEnabled: true,
};

// Reused across frames by feel.offset() - the caller reads .x/.y synchronously and
// never retains the object, so filling+returning this avoids a per-rendered-frame
// allocation (there is exactly one caller, in screens.js's drawFight).
const OFFSET_SCRATCH = { x: 0, y: 0 };

export const feel = {
  hitstop(frames) {
    feelState.hitstopFrames = Math.max(feelState.hitstopFrames, frames | 0);
  },
  shake(mag, frames) {
    feelState.shakeMag = Math.max(feelState.shakeMag, mag);
    feelState.shakeFrames = Math.max(feelState.shakeFrames, frames | 0);
    feelState.shakeTotal = Math.max(feelState.shakeTotal, frames | 0) || 1;
  },
  flash(color, frames) {
    feelState.flashColor = color;
    feelState.flashFrames = Math.max(feelState.flashFrames, frames | 0);
    feelState.flashTotal = Math.max(feelState.flashTotal, frames | 0) || 1;
  },
  slowmo(factor, frames) {
    feelState.slowmoFactor = factor;
    feelState.slowmoFrames = Math.max(feelState.slowmoFrames, frames | 0);
  },

  /** Advance all feel timers by one rendered frame. */
  update() {
    if (feelState.hitstopFrames > 0) feelState.hitstopFrames--;
    if (feelState.shakeFrames > 0) feelState.shakeFrames--;
    else { feelState.shakeMag = 0; feelState.shakeTotal = 0; }
    if (feelState.flashFrames > 0) feelState.flashFrames--;
    else { feelState.flashColor = null; feelState.flashTotal = 0; }
    if (feelState.slowmoFrames > 0) feelState.slowmoFrames--;
    else feelState.slowmoFactor = 1;
  },

  /** true while hitstop should freeze sim ticks entirely. */
  hitstopActive() {
    return feelState.hitstopFrames > 0;
  },

  /** Multiplier the main loop applies to its tick accumulator: 0 (frozen), <1 (slowmo), or 1. */
  timeScale() {
    if (feelState.hitstopFrames > 0) return 0;
    if (feelState.slowmoFrames > 0) return feelState.slowmoFactor;
    return 1;
  },

  /** Camera shake offset in pixels, {x,y}. Respects setShakeEnabled(false). Returns a
   *  reused scratch object (read immediately by the single caller in screens.js) - not
   *  safe to retain across frames. */
  offset() {
    OFFSET_SCRATCH.x = 0; OFFSET_SCRATCH.y = 0;
    if (!feelState.shakeEnabled || feelState.shakeFrames <= 0) return OFFSET_SCRATCH;
    const decay = feelState.shakeFrames / (feelState.shakeTotal || 1);
    const m = feelState.shakeMag * decay;
    OFFSET_SCRATCH.x = (Math.random() * 2 - 1) * m;
    OFFSET_SCRATCH.y = (Math.random() * 2 - 1) * m;
    return OFFSET_SCRATCH;
  },

  /** Full-screen flash overlay. Respects setFlashEnabled(false). No-op if no active flash. */
  apply(ctx) {
    if (!feelState.flashEnabled || !feelState.flashColor || feelState.flashFrames <= 0) return;
    const decay = feelState.flashFrames / feelState.flashTotal;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, decay));
    ctx.fillStyle = feelState.flashColor;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  },

  setShakeEnabled(on) { feelState.shakeEnabled = !!on; },
  setFlashEnabled(on) { feelState.flashEnabled = !!on; },
};
