// js/placeholder.js — procedural colored "capsule fighter" renderer.
// Used by the fight screen ONLY when a fighter's real atlas image 404s (js/atlas.js's
// loadAtlas rejects cleanly on a missing sheet so the caller can fall back to this instead).
// No image assets, no canvas caching needed — pure vector shapes drawn every call, cheap.
//
// export function drawCapsuleFighter(ctx, brandHex, poseName, tFrames, x, y, flip)
// Anchored bottom-center at (x,y), same convention as js/atlas.js's drawPose, so a caller
// can swap between the two renderers without touching its own layout math.

function clampByte(v) { return Math.max(0, Math.min(255, v)); }

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  const num = parseInt(n, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/** shade(hex, +0.2) lightens, shade(hex, -0.3) darkens. */
function shade(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => clampByte(Math.round(amt >= 0 ? c + (255 - c) * amt : c + c * amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function drawStadium(ctx, cx, top, w, h, fill) {
  const r = w / 2;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(cx - r, top + r);
  ctx.arc(cx, top + r, r, Math.PI, 0, false);
  ctx.lineTo(cx + r, top + h - r);
  ctx.arc(cx, top + h - r, r, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();
}

// Pose table: one entry per atlas pose name (design/contracts.md atlas JSON pose keys).
// height = body squash factor, limb = which procedural limb flourish to draw (facing +x,
// mirrored automatically by the caller's ctx.scale(-1,1) when flip is set).
const POSES = {
  idle: { height: 1, bob: true },
  walk: { height: 1, bob: true, step: true },
  jump: { height: 1, lift: true },
  crouch: { height: 0.62 },
  block: { height: 1, limb: 'block' },
  punchL: { height: 1, limb: 'punch', reach: 0.55 },
  punchH: { height: 1, limb: 'punch', reach: 0.95 },
  kickL: { height: 1, limb: 'kick', reach: 0.55 },
  kickH: { height: 1, limb: 'kick', reach: 0.95 },
  special1: { height: 1, limb: 'punch', reach: 0.8, glow: true },
  super: { height: 1.05, limb: 'punch', reach: 1, glow: true, big: true },
  hit: { height: 0.95, flinch: true },
  ko: { height: 0.32, collapsed: true },
  win: { height: 1, limb: 'up' },
  intro: { height: 1 },
  taunt: { height: 1, limb: 'up' },
  throw: { height: 1, limb: 'grab', reach: 0.7 },
};

export function drawCapsuleFighter(ctx, brandHex, poseName, tFrames, x, y, flip) {
  const pose = POSES[poseName] || POSES.idle;
  const bodyW = 64;
  const bodyH = 118 * pose.height;
  const t = Math.max(0, tFrames || 0);
  const bob = pose.bob ? Math.sin(t * 0.15) * 3 : 0;
  const lift = pose.lift ? -18 : 0;
  const jitter = pose.flinch ? Math.sin(t * 2.2) * 4 : 0;

  ctx.save();
  ctx.translate(x + jitter, y + lift - bob);
  if (flip) ctx.scale(-1, 1);
  if (pose.collapsed) { ctx.rotate(Math.PI / 2 * Math.min(1, t / 14)); }

  // ground shadow
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(0, 4, bodyW * 0.48, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // legs
  const legSwing = pose.step ? Math.sin(t * 0.35) * 12 : 0;
  const legW = 16;
  const legH = bodyH * 0.42;
  ctx.fillStyle = shade(brandHex, -0.45);
  ctx.fillRect(-legW - 4 + legSwing * 0.3, -legH, legW, legH);
  ctx.fillRect(4 - legSwing * 0.3, -legH, legW, legH);

  // torso capsule
  drawStadium(ctx, 0, -bodyH, bodyW, bodyH * 0.72, shade(brandHex, -0.1));

  // chest emblem stripe (brand accent)
  ctx.fillStyle = brandHex;
  ctx.fillRect(-bodyW * 0.16, -bodyH * 0.62, bodyW * 0.32, bodyH * 0.3);

  // head
  const headR = bodyW * 0.3;
  const headCy = -bodyH - headR * 0.5;
  ctx.fillStyle = shade(brandHex, 0.2);
  ctx.beginPath();
  ctx.arc(0, headCy, headR, 0, Math.PI * 2);
  ctx.fill();

  // visor / eyes
  ctx.fillStyle = pose.flinch ? '#FF5A4A' : '#FFFFFF';
  ctx.fillRect(-headR * 0.55, headCy - headR * 0.12, headR * 1.1, headR * 0.32);
  ctx.fillStyle = shade(brandHex, -0.4);
  ctx.fillRect(-headR * 0.4, headCy - headR * 0.05, headR * 0.28, headR * 0.16);
  ctx.fillRect(headR * 0.12, headCy - headR * 0.05, headR * 0.28, headR * 0.16);

  // limb flourish
  const armY = -bodyH * 0.55;
  if (pose.limb === 'punch' || pose.limb === 'kick' || pose.limb === 'grab') {
    const reach = bodyW * 1.5 * (pose.reach || 0.6);
    const fromY = pose.limb === 'kick' ? -legH * 0.5 : armY;
    ctx.strokeStyle = shade(brandHex, -0.2);
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bodyW * 0.3, fromY);
    ctx.lineTo(bodyW * 0.3 + reach, fromY - (pose.limb === 'kick' ? -10 : 6));
    ctx.stroke();
    if (pose.glow) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = brandHex;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 0.5);
      ctx.lineWidth = pose.big ? 26 : 18;
      ctx.stroke();
      ctx.restore();
    }
  } else if (pose.limb === 'block') {
    ctx.fillStyle = shade(brandHex, -0.25);
    ctx.fillRect(-bodyW * 0.55, armY - 10, bodyW * 1.1, 20);
  } else if (pose.limb === 'up') {
    ctx.strokeStyle = shade(brandHex, -0.15);
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-bodyW * 0.3, armY);
    ctx.lineTo(-bodyW * 0.5, armY - bodyH * 0.35);
    ctx.moveTo(bodyW * 0.3, armY);
    ctx.lineTo(bodyW * 0.5, armY - bodyH * 0.35);
    ctx.stroke();
  } else {
    // idle/default arms: short stubs at the sides
    ctx.fillStyle = shade(brandHex, -0.25);
    ctx.fillRect(-bodyW * 0.62, armY, 12, bodyH * 0.3);
    ctx.fillRect(bodyW * 0.5, armY, 12, bodyH * 0.3);
  }

  ctx.restore();
}
