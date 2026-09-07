// js/stages.js — animated stage runtime (design/contracts.md pinned API):
//   export const stageRt = { load(stageId), update(), draw(ctx, cam, layer /*'bg'|'fg'*/) }
//
// Assumptions (stated in the handoff report too):
// - ctx is already in the 1920x1080 virtual world coordinate space (letterboxed scale-to-fit
//   is applied upstream by the caller/index.html, same space core.js positions live in), so
//   this module draws against fixed WORLD_W/WORLD_H rather than ctx.canvas.width/height.
// - cam is {x,y,zoom} world-space camera (v2.1: zoom added). This module does NOT rely on an
//   outer ctx transform for the camera - it applies cam itself so each parallax band can zoom
//   by a DIFFERENT fraction of cam.zoom (far layers zoom/pan less, deepening parallax under
//   zoom), while the fighters/vfx layer (drawn by screens.js) uses the full 1:1 cam - matching
//   this module's 'floor' band exactly. A missing cam or cam.zoom defaults to {x:0,y:0,zoom:1}
//   (unchanged v1/v2 behaviour).
// - STAGES[id] fields used (matches js/data.js): file (bg png), npc (npc sheet png or
//   undefined), npcPlacements ([{x,y}] world coords), ambient ('motes'|'rain'|'embers'|
//   'clouds'|'crowd-lights'|'birds'), parallax ([{layer:'far'|'mid',speed:N}, ...] a
//   per-mille scroll-speed override per named layer, speed 100 => 0.1x). This module still
//   owns the actual "slice one image into far/mid/floor bands" geometry (DEFAULT_BANDS);
//   a stage only overrides the far/mid factor by layer name. Floor always scrolls 1.0x.
// - Everything renders acceptably before/without the PNGs: a stage-hued gradient fallback
//   stands in for a missing/loading background; a missing npc sheet just skips NPC drawing.
import { STAGES } from './data.js';

const WORLD_W = 1920;
const WORLD_H = 1080;

// v2.1: far/mid factors bumped to 0.25/0.55 per design/contracts.md's v2.1 addendum
// ("far layer translates/scales at 0.25x of cam, mid 0.55x, floor 1.0x").
// v2.2: each band also gets its OWN vertical zoom anchor (anchorY, world px) instead of
// sharing the fixed screen center (960,540) - see contracts.md "Stage band zoom anchors".
// far anchors at its own top edge (0) so it grows safely DOWN behind the mid band instead of
// cropping above the screen top; mid and floor both anchor at 880 (FLOOR_Y/FP, the world floor
// line fighters stand on) so their zoom stays pinned to the same fixed point the sim's ground
// plane occupies, instead of drifting apart around a shared-but-irrelevant screen center.
const DEFAULT_BANDS = [
  { name: 'far', srcYFrac: 0.0, srcHFrac: 0.42, dstYFrac: 0.0, dstHFrac: 0.48, factor: 0.25, anchorY: 0 },
  { name: 'mid', srcYFrac: 0.4, srcHFrac: 0.35, dstYFrac: 0.38, dstHFrac: 0.38, factor: 0.55, anchorY: 880 },
  { name: 'floor', srcYFrac: 0.72, srcHFrac: 0.28, dstYFrac: 0.62, dstHFrac: 0.38, factor: 1.0, anchorY: 880 },
];

// Cheer envelope tuning (NPC bob + crowd-lights pulse - see stageRt.cheer()).
const CHEER_BOB_BASE = 4;    // idle bob amplitude, world px
const CHEER_BOB_RANGE = 22;  // added on top of base at full cheerAmp (4+22=~26 per contract)
const CHEER_RELEASE = 0.06;  // cheerAmp eased toward 0 by this much per frame once ttl expires

const FALLBACK_HUES = {
  s1: ['#122024', '#080e10'], // data-dojo: cool server-rack teal
  s2: ['#1c1030', '#050308'], // neon-city: rain-slick violet
  s3: ['#3a2a20', '#10141c'], // kk-waterfront: sunset amber
  s4: ['#1e3550', '#0a121c'], // cloud-temple: sky blue
  s5: ['#0e2732', '#070d10'], // nextgen-lab: cyan tech
  s6: ['#3a0d0c', '#0e0202'], // circuit-volcano: lava red
  default: ['#141416', '#0a0a0c'],
};

function loadImageSafe(src, onDone) {
  const img = new Image();
  img.onload = () => onDone(img, false);
  img.onerror = () => onDone(null, true);
  img.src = src;
  return img;
}

// ---- ambient particle pool: stages.js owns a small independent pool (separate from
// js/vfx.js's combat-FX pool), preallocated once and reused across every stage switch. ----
const AMBIENT_CAP = 40;
function makeAmbient() {
  return { active: false, kind: '', x: 0, y: 0, vx: 0, vy: 0, size: 1, alpha: 1, phase: 0 };
}
const AMBIENT = new Array(AMBIENT_CAP);
for (let i = 0; i < AMBIENT_CAP; i++) AMBIENT[i] = makeAmbient();

function acquireAmbient() {
  for (let i = 0; i < AMBIENT_CAP; i++) if (!AMBIENT[i].active) return AMBIENT[i];
  return null;
}

function seedAmbientParticle(p, kind) {
  p.active = true;
  p.kind = kind;
  p.phase = Math.random() * Math.PI * 2;
  switch (kind) {
    case 'rain':
      p.x = Math.random() * WORLD_W;
      p.y = -Math.random() * WORLD_H * 0.3;
      p.vx = -2.5;
      p.vy = 14 + Math.random() * 6;
      p.size = 12 + Math.random() * 10;
      p.alpha = 0.25 + Math.random() * 0.2;
      break;
    case 'embers':
      p.x = Math.random() * WORLD_W;
      p.y = WORLD_H + Math.random() * 40;
      p.vx = (Math.random() - 0.5) * 0.6;
      p.vy = -(0.6 + Math.random() * 1.2);
      p.size = 2 + Math.random() * 3;
      p.alpha = 0.6 + Math.random() * 0.4;
      break;
    case 'clouds':
      p.x = WORLD_W + Math.random() * 200;
      p.y = 60 + Math.random() * (WORLD_H * 0.4);
      p.vx = -(0.15 + Math.random() * 0.2);
      p.vy = 0;
      p.size = 120 + Math.random() * 160;
      p.alpha = 0.08 + Math.random() * 0.1;
      break;
    case 'birds':
      p.x = -40;
      p.y = 80 + Math.random() * (WORLD_H * 0.35);
      p.vx = 1.4 + Math.random() * 1.2;
      p.vy = 0;
      p.size = 10 + Math.random() * 6;
      p.alpha = 0.5 + Math.random() * 0.3;
      break;
    case 'crowd-lights':
      p.x = Math.random() * WORLD_W;
      p.y = WORLD_H * 0.35 + Math.random() * (WORLD_H * 0.3);
      p.vx = 0;
      p.vy = 0;
      p.size = 2 + Math.random() * 2;
      p.alpha = 0.5 + Math.random() * 0.5;
      break;
    case 'motes':
    default:
      p.x = Math.random() * WORLD_W;
      p.y = Math.random() * WORLD_H;
      p.vx = (Math.random() - 0.5) * 0.3;
      p.vy = -(0.15 + Math.random() * 0.25);
      p.size = 1.5 + Math.random() * 2;
      p.alpha = 0.35 + Math.random() * 0.35;
      break;
  }
}

function ambientTargetCount(kind) {
  switch (kind) {
    case 'rain': return 34;
    case 'embers': return 26;
    case 'clouds': return 6;
    case 'birds': return 4;
    case 'crowd-lights': return 22;
    case 'motes':
    default: return 20;
  }
}

// ---- current stage runtime state ----
let current = null;

function fallbackMeta(stageId) {
  return { name: stageId || 'unknown', file: null, npc: null, npcPlacements: [], ambient: 'motes', parallax: null };
}

// data.js's STAGES.parallax is authored as [{layer:'far'|'mid', speed:N}, ...] — a per-mille
// scroll-speed knob per named layer (speed 100 => 0.1x, matching this codebase's other
// per-mille conventions), NOT the {srcYFrac,dstYFrac,factor,...} band geometry itself. This
// module owns that geometry (DEFAULT_BANDS, the "slice one image into far/mid/floor bands"
// hack); a stage's parallax array only overrides the far/mid scroll FACTOR by name. The
// floor band always scrolls at 1.0x (ties to fighter/world motion) and is not authorable.
function resolveBands(meta) {
  const speedByLayer = {};
  if (Array.isArray(meta.parallax)) {
    for (const entry of meta.parallax) {
      if (entry && entry.layer) speedByLayer[entry.layer] = entry.speed;
    }
  }
  return DEFAULT_BANDS.map((b) => {
    const speed = speedByLayer[b.name];
    return typeof speed === 'number' ? { ...b, factor: speed / 1000 } : b;
  });
}

export const stageRt = {
  load(stageId) {
    const meta = STAGES && STAGES[stageId] ? STAGES[stageId] : fallbackMeta(stageId);
    for (let i = 0; i < AMBIENT_CAP; i++) AMBIENT[i].active = false;

    current = {
      id: stageId,
      meta,
      bands: resolveBands(meta),
      frame: 0,
      bg: { img: null, failed: !meta.file, loading: !!meta.file },
      npc: { img: null, failed: !meta.npc, loading: !!meta.npc },
      cheerAmp: 0, // 0..1 current crowd cheer intensity (sustains then eases out)
      cheerTtl: 0, // frames left at full cheerAmp before the release-ease begins
    };

    if (meta.file) {
      loadImageSafe(meta.file, (img, failed) => {
        if (current && current.id === stageId) {
          current.bg.img = img;
          current.bg.failed = failed;
          current.bg.loading = false;
        }
      });
    }
    if (meta.npc) {
      loadImageSafe(meta.npc, (img, failed) => {
        if (current && current.id === stageId) {
          current.npc.img = img;
          current.npc.failed = failed;
          current.npc.loading = false;
        }
      });
    }
  },

  update() {
    if (!current) return;
    current.frame++;

    // Cheer envelope: sustain at the requested amp while cheerTtl counts down, then ease the
    // amp back to 0 (CHEER_RELEASE per frame) so a ko/ultimate cheer fades out smoothly
    // instead of cutting off - purely current.frame-driven, no Math.random/Date.now.
    if (current.cheerTtl > 0) {
      current.cheerTtl--;
    } else if (current.cheerAmp > 0) {
      current.cheerAmp = Math.max(0, current.cheerAmp - CHEER_RELEASE);
    }

    const kind = current.meta.ambient || 'motes';
    const target = ambientTargetCount(kind);

    let alive = 0;
    for (let i = 0; i < AMBIENT_CAP; i++) if (AMBIENT[i].active && AMBIENT[i].kind === kind) alive++;
    while (alive < target) {
      const p = acquireAmbient();
      if (!p) break;
      seedAmbientParticle(p, kind);
      alive++;
    }

    for (let i = 0; i < AMBIENT_CAP; i++) {
      const p = AMBIENT[i];
      if (!p.active || p.kind !== kind) continue;
      p.phase += 0.05;
      if (kind === 'motes') {
        p.x += p.vx + Math.sin(p.phase) * 0.15;
        p.y += p.vy;
        if (p.y < -5) seedAmbientParticle(p, kind);
      } else if (kind === 'rain') {
        p.x += p.vx;
        p.y += p.vy;
        if (p.y > WORLD_H + 10) seedAmbientParticle(p, kind);
      } else if (kind === 'embers') {
        p.x += p.vx + Math.sin(p.phase) * 0.2;
        p.y += p.vy;
        if (p.y < -10) seedAmbientParticle(p, kind);
      } else if (kind === 'clouds') {
        p.x += p.vx;
        if (p.x < -p.size) seedAmbientParticle(p, kind);
      } else if (kind === 'birds') {
        p.x += p.vx;
        p.y += Math.sin(p.phase) * 0.3;
        if (p.x > WORLD_W + 40) seedAmbientParticle(p, kind);
      }
      // 'crowd-lights' particles are stationary; only their phase (twinkle) advances.
    }
  },

  draw(ctx, cam, layer) {
    if (!current) return;
    const camX = (cam && cam.x) || 0;
    const camY = (cam && cam.y) || 0;
    const zoom = (cam && cam.zoom) || 1;

    if (layer === 'fg') {
      drawForeground(ctx, camX, zoom);
      return;
    }

    // 'bg' (default) layer: parallax background, ambient FX, then NPC loops.
    if (current.bg.img) {
      const bands = current.bands;
      for (let i = 0; i < bands.length && i < 3; i++) drawBand(ctx, current.bg.img, bands[i], camX, zoom);
      drawSeamScrim(ctx);
    } else {
      drawGradientFallback(ctx, current.id);
    }

    drawAmbient(ctx, camX, camY, zoom);
    drawNpcs(ctx, camX, camY, zoom);
  },

  // Crowd cheer trigger (v2.2): screens.js calls this on ko/transform/ultimate/combo>=3 hits.
  // Sets the current stage's cheerAmp/cheerTtl; update() sustains then eases it back to 0.
  // Safe to call at any time, including before load(stageId) has ever run (no-op, no throw).
  cheer(intensity, frames) {
    if (!current) return;
    current.cheerAmp = Math.max(0, Math.min(1, intensity || 0));
    current.cheerTtl = Math.max(0, frames || 0);
  },
};

// v2.1: each band zooms by ITS OWN fraction of cam.zoom (bandZoom = 1 + (zoom-1)*factor) so
// far layers barely zoom while the floor band zooms 1:1 with the fighters - this is what
// "deepens parallax under zoom" (contracts.md v2.1 addendum).
// v2.2: the zoom is applied about (WORLD_W/2, band.anchorY) instead of the fixed screen
// center (960,540) - see DEFAULT_BANDS comment above. This keeps far's top edge from
// scaling above y=0 (was cropping the s1 banner art off-screen) and keeps mid/floor scaling
// about the SAME fixed point (the world floor line), so their zoom no longer diverges around
// an arbitrary shared center - composes cleanly with the existing camX*factor scroll
// (unaffected) and the outer DPR/letterbox transform main.js already set.
function drawBand(ctx, img, band, camX, zoom) {
  const bandZoom = 1 + (zoom - 1) * band.factor;
  const srcY = img.height * band.srcYFrac;
  const srcH = Math.max(1, img.height * band.srcHFrac);
  const dstY = WORLD_H * band.dstYFrac;
  const dstH = WORLD_H * band.dstHFrac;
  const dstW = WORLD_W * 1.5; // margin so shake/scroll never reveals a seam
  const scrollX = -(camX * band.factor) % dstW;
  const anchorY = band.anchorY;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(WORLD_W / 2, anchorY);
  ctx.scale(bandZoom, bandZoom);
  ctx.translate(-WORLD_W / 2, -anchorY);
  for (let k = -1; k <= 1; k++) {
    ctx.drawImage(img, 0, srcY, img.width, srcH, scrollX + k * dstW, dstY, dstW, dstH);
  }
  ctx.restore();
}

// Seam scrim (v2.2 polish): the mid band (anchorY 880, factor 0.55) and the floor band
// (anchorY 880, factor 1.0) still zoom at different RATES even though they now share the same
// anchor, so a thin residual seam can still show at extreme zoom. A ~16px soft dark gradient
// centered on y=880 (the same fixed anchor both bands scale around, so this line itself never
// drifts) hides that residual contrast cheaply. The CanvasGradient is built once and reused -
// gradient objects are not bound to a specific context, so caching across frames/canvases is
// safe and avoids a per-frame allocation.
let seamGradient = null;
function getSeamGradient(ctx) {
  if (!seamGradient) {
    seamGradient = ctx.createLinearGradient(0, 872, 0, 888);
    seamGradient.addColorStop(0, 'rgba(0,0,0,0)');
    seamGradient.addColorStop(0.5, 'rgba(0,0,0,0.32)');
    seamGradient.addColorStop(1, 'rgba(0,0,0,0)');
  }
  return seamGradient;
}

function drawSeamScrim(ctx) {
  ctx.save();
  ctx.fillStyle = getSeamGradient(ctx);
  ctx.fillRect(0, 872, WORLD_W, 16);
  ctx.restore();
}

// Cached per stageId, same reasoning as getSeamGradient above: a CanvasGradient isn't
// bound to a specific context, so building it once per stageId and reusing it avoids a
// per-frame allocation while the stage art is loading/missing.
const gradientFallbackCache = new Map();
function drawGradientFallback(ctx, stageId) {
  let g = gradientFallbackCache.get(stageId);
  if (!g) {
    const hues = FALLBACK_HUES[stageId] || FALLBACK_HUES.default;
    g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
    g.addColorStop(0, hues[0]);
    g.addColorStop(1, hues[1]);
    gradientFallbackCache.set(stageId, g);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
}

// NPCs/ambient stand at floor depth (same plane as the fighters), so they zoom 1:1 with
// cam.zoom - a plain uniform scale around the world center, composed with the existing
// camX*0.6/camY*0.6 ambient drift and the 1:1 npc camX/camY follow (both unchanged).
function drawAmbient(ctx, camX, camY, zoom) {
  const kind = current.meta.ambient || 'motes';
  const cheerAmp = current.cheerAmp || 0; // 0..1, see stageRt.cheer()
  ctx.save();
  ctx.translate(WORLD_W / 2, WORLD_H / 2);
  ctx.scale(zoom || 1, zoom || 1);
  ctx.translate(-WORLD_W / 2, -WORLD_H / 2);
  for (let i = 0; i < AMBIENT_CAP; i++) {
    const p = AMBIENT[i];
    if (!p.active || p.kind !== kind) continue;
    const sx = p.x - camX * 0.6; // ambient FX drift slightly with the camera, not 1:1
    const sy = p.y - camY * 0.6;

    if (kind === 'rain') {
      ctx.globalAlpha = p.alpha;
      ctx.strokeStyle = '#BFE9F5';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + p.vx * 1.5, sy - p.size);
      ctx.stroke();
    } else if (kind === 'embers') {
      ctx.globalAlpha = p.alpha * (0.6 + 0.4 * Math.sin(p.phase * 2));
      ctx.fillStyle = '#FF8A3D';
      ctx.beginPath();
      ctx.arc(sx, sy, p.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'clouds') {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.ellipse(sx, sy, p.size, p.size * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'birds') {
      ctx.globalAlpha = p.alpha;
      ctx.strokeStyle = '#1A1A1A';
      ctx.lineWidth = 2;
      const flap = Math.sin(p.phase * 4) * p.size * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx - p.size, sy - flap);
      ctx.lineTo(sx, sy);
      ctx.lineTo(sx + p.size, sy - flap);
      ctx.stroke();
    } else if (kind === 'crowd-lights') {
      // Cheer boost: alpha/size scale by (1 + cheerAmp) while the crowd is cheering.
      const boost = 1 + cheerAmp;
      const sz = p.size * boost;
      ctx.globalAlpha = Math.min(1, p.alpha * (0.5 + 0.5 * Math.sin(p.phase * 3)) * boost);
      ctx.fillStyle = '#FFE94A';
      ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
    } else {
      // motes (default)
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = '#16C7E4';
      ctx.beginPath();
      ctx.arc(sx, sy, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawNpcs(ctx, camX, camY, zoom) {
  if (!current.npc.img) return;
  const img = current.npc.img;
  const cellW = img.width / 2;
  const cellH = img.height / 2;
  const frameIdx = Math.floor(current.frame / 10) % 4; // 2x2 grid, 4-frame loop @ 6fps
  const sx = (frameIdx % 2) * cellW;
  const sy = Math.floor(frameIdx / 2) * cellH;

  const placements = (current.meta.npcPlacements && current.meta.npcPlacements.length)
    ? current.meta.npcPlacements
    : defaultPlacements();

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(WORLD_W / 2, WORLD_H / 2);
  ctx.scale(zoom || 1, zoom || 1);
  ctx.translate(-WORLD_W / 2, -WORLD_H / 2);
  const drawH = 160;
  const drawW = drawH * (cellW / cellH);
  // Cheer bob (v2.2): idle amplitude CHEER_BOB_BASE, rising toward CHEER_BOB_BASE+CHEER_BOB_RANGE
  // (~26 world px) while cheering. Derives ONLY from current.frame + placement index i - no
  // Math.random/Date.now per frame, so it stays deterministic (lockstep-safe, renderer-only).
  const bobAmp = CHEER_BOB_BASE + CHEER_BOB_RANGE * (current.cheerAmp || 0);
  let i = 0;
  for (const place of placements) {
    const bob = bobAmp * Math.abs(Math.sin(current.frame * 0.09 + i * 1.7));
    const dx = place.x - camX - drawW / 2;
    const dy = place.y - camY - drawH - bob;
    ctx.drawImage(img, sx, sy, cellW, cellH, dx, dy, drawW, drawH);
    i++;
  }
  ctx.restore();
}

function defaultPlacements() {
  return [
    { x: WORLD_W * 0.18, y: WORLD_H * 0.62 },
    { x: WORLD_W * 0.5, y: WORLD_H * 0.6 },
    { x: WORLD_W * 0.82, y: WORLD_H * 0.62 },
  ];
}

// Optional foreground layer: a cheap darkened sliver cropped from the loaded background
// (or a flat scrim if art hasn't loaded), used sparingly to add depth in front of the fighters.
function drawForeground(ctx, camX, zoom) {
  if (!current) return;
  ctx.save();
  ctx.translate(WORLD_W / 2, WORLD_H / 2);
  ctx.scale(zoom || 1, zoom || 1);
  ctx.translate(-WORLD_W / 2, -WORLD_H / 2);
  if (current.bg.img) {
    const img = current.bg.img;
    const srcY = img.height * 0.9;
    const srcH = Math.max(1, img.height * 0.1);
    const dstW = WORLD_W * 1.5;
    const scrollX = -(camX * 1.15) % dstW;
    ctx.globalAlpha = 0.35;
    ctx.imageSmoothingEnabled = false;
    for (let k = -1; k <= 1; k++) {
      ctx.drawImage(img, 0, srcY, img.width, srcH, scrollX + k * dstW, WORLD_H - 60, dstW, 90);
    }
  } else {
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, WORLD_H - 60, WORLD_W, 60);
  }
  ctx.restore();
}
