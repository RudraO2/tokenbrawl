// js/atlas.js — sprite-sheet atlas loader + pose renderer.
// Pinned API (design/contracts.md):
//   loadAtlas(jsonUrl) -> Promise<{img, cell:{w,h}, grid:{cols,rows}, poses}>
//   drawPose(ctx, atlas, poseName, tFrames, x, y, {flip, scale, alpha, tint})
//
// Contract notes honored here:
// - loadAtlas rejects cleanly (never throws synchronously, never resolves with a broken
//   image) on a 404/network failure so callers (fight screen) can fall back to
//   js/placeholder.js's procedural capsule fighter.
// - drawPose draws bottom-center anchored at (x,y), imageSmoothingEnabled = false (retro,
//   no blur), flip = horizontal mirror around the anchor, tint = cached recolor via a
//   small per-atlas LRU of offscreen canvases.
// - A missing/unknown pose name silently falls back to 'idle'.

/**
 * Resolve `relPath` against the directory of `baseUrl` using plain string logic
 * (no DOM / document.baseURI dependency, so this works identically in a browser
 * tab or a headless check). Handles './' and '../' segments and absolute paths.
 */
function resolveRelative(baseUrl, relPath) {
  if (/^([a-z]+:)?\/\//i.test(relPath) || relPath.startsWith('/')) return relPath;
  const baseDir = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  const parts = (baseDir + relPath).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const leadingSlash = baseDir.startsWith('/') ? '/' : '';
  return leadingSlash + out.join('/');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('atlas image failed to load: ' + src));
    img.src = src;
  });
}

/** Fetch an atlas JSON + its spritesheet image. Rejects cleanly on any 404/parse error. */
export async function loadAtlas(jsonUrl) {
  const res = await fetch(jsonUrl);
  if (!res || !res.ok) throw new Error('atlas json 404: ' + jsonUrl);
  const json = await res.json();
  const imgUrl = resolveRelative(jsonUrl, json.image);
  const img = await loadImage(imgUrl);
  const cols = json.grid.cols;
  const rows = json.grid.rows;
  // Derive the real cell size from the loaded image + grid rather than trusting the JSON's
  // declared cell.w/h verbatim: exported sheet pixel dims don't always divide evenly (e.g. a
  // 1024x1024 5x5 sheet is 204.8px/cell), so this stays correct regardless of rounding.
  return {
    img,
    cell: { w: img.width / cols, h: img.height / rows },
    grid: { cols, rows },
    poses: json.poses,
  };
}

// ---- tint cache: WeakMap<atlas -> Map<tintColor -> canvas>>, small per-atlas LRU ----
const TINT_LRU_CAP = 6;
const tintCacheByAtlas = new WeakMap();

function getTintedCanvas(atlas, tint) {
  let cache = tintCacheByAtlas.get(atlas);
  if (!cache) {
    cache = new Map();
    tintCacheByAtlas.set(atlas, cache);
  }
  if (cache.has(tint)) {
    // refresh recency (delete + re-set moves it to the end of Map's insertion order)
    const c = cache.get(tint);
    cache.delete(tint);
    cache.set(tint, c);
    return c;
  }
  const w = atlas.img.width;
  const h = atlas.img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.drawImage(atlas.img, 0, 0, w, h);
  // multiply the tint in, then restore the original alpha mask so shading survives
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = tint;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(atlas.img, 0, 0, w, h);
  c.globalCompositeOperation = 'source-over';

  cache.set(tint, canvas);
  if (cache.size > TINT_LRU_CAP) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  return canvas;
}

function pickPose(atlas, poseName) {
  return atlas.poses[poseName] || atlas.poses.idle;
}

function frameIndexFor(pose, tFrames) {
  const fps = pose.fps > 0 ? pose.fps : 1;
  const ticksPerCell = 60 / fps; // sim runs at fixed 60Hz (design/contracts.md)
  const n = pose.cells.length;
  let idx = Math.floor(Math.max(0, tFrames) / ticksPerCell);
  if (pose.loop) idx = idx % n;
  else idx = Math.min(idx, n - 1);
  return pose.cells[idx];
}

// ---- content-bottom grounding (FIX A) --------------------------------------
// drawPose anchors at the fixed CELL bottom (208), but a lot of the art sits high
// inside its cell (jump tucks the legs up; crouch floats), so those poses render
// "floating/small". When a caller passes groundToContent:true we shift the whole
// cell DOWN by the empty gap below the pose's real content, so the figure's TRUE
// feet land on (x,y). Measured lazily from the sheet's alpha and cached per
// atlas+pose. groundToContent:false (the default) stays byte-identical to before.
const ALPHA_MIN = 16;   // ignore near-transparent edge pixels
const ROW_MIN_PX = 3;   // a row counts as "content" only with >=3 opaque px (skips 1-2px specks)
const ABS_MAX_DIM = 2048; // hard sanity cap on any drawn sprite dimension (FIX E)

// Build (once) a same-origin alpha snapshot of the sheet. Returns null when the
// read is impossible (headless/node, or a tainted canvas) so grounding no-ops.
function ensureAlphaBuffer(atlas) {
  if (atlas._alpha !== undefined) return atlas._alpha;
  atlas._alpha = null;
  try {
    if (typeof document === 'undefined') return null;
    const iw = atlas.img.width | 0, ih = atlas.img.height | 0;
    if (!iw || !ih) return null;
    const cv = document.createElement('canvas');
    cv.width = iw; cv.height = ih;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.imageSmoothingEnabled = false;
    c.drawImage(atlas.img, 0, 0);
    const id = c.getImageData(0, 0, iw, ih);
    atlas._alpha = { d: id.data, w: iw, h: ih };
  } catch (e) {
    atlas._alpha = null; // cross-origin / read blocked: silently skip grounding
  }
  return atlas._alpha;
}

// Lowest opaque row (1..ch) inside one cell, or 0 if the cell is empty.
function cellContentBottom(buf, cw, ch, cols, cellIdx) {
  const col = cellIdx % cols, row = Math.floor(cellIdx / cols);
  const sx = Math.floor(col * cw), sy = Math.floor(row * ch);
  const cwi = Math.min(Math.round(cw), buf.w - sx);
  const chi = Math.min(Math.round(ch), buf.h - sy);
  const data = buf.d, W = buf.w;
  for (let ly = chi - 1; ly >= 0; ly--) {
    let cnt = 0;
    const base = ((sy + ly) * W + sx) * 4 + 3; // +3 -> alpha channel
    for (let lx = 0; lx < cwi; lx++) {
      if (data[base + lx * 4] > ALPHA_MIN) { cnt++; if (cnt >= ROW_MIN_PX) return ly + 1; }
    }
  }
  return 0;
}

// Per-pose ground offset in px = cellBottom - contentBottom, clamped >=0. Uses the
// MAX content-bottom across the pose's cells (== the smallest shift) so the most-
// grounded frame sits exactly on the floor and no frame ever sinks below it, and
// the offset stays constant as the pose's cells cycle (no vertical bob).
function poseGroundOffset(atlas, poseName) {
  if (!atlas._ground) atlas._ground = Object.create(null);
  const cached = atlas._ground[poseName];
  if (cached !== undefined) return cached;
  let off = 0;
  const buf = ensureAlphaBuffer(atlas);
  const pose = atlas.poses && (atlas.poses[poseName] || atlas.poses.idle);
  if (buf && pose && pose.cells && pose.cells.length) {
    const { w: cw, h: ch } = atlas.cell;
    const cols = atlas.grid.cols;
    let maxBottom = 0;
    for (let i = 0; i < pose.cells.length; i++) {
      const b = cellContentBottom(buf, cw, ch, cols, pose.cells[i]);
      if (b > maxBottom) maxBottom = b;
    }
    if (maxBottom > 0) {
      off = Math.round(ch - maxBottom);
      if (off < 0) off = 0; else if (off > ch) off = ch;
    }
  }
  atlas._ground[poseName] = off;
  return off;
}

// Opaque-MASS vertical centroid of a pose, in px UP from the cell bottom (unscaled).
// drawPose bottom-anchors the CELL, but CENTERED fx (streak / slash speed-lines) sit
// high inside their cell, so anchoring by the cell middle floats them ~cell/2 too high
// ("streak on the head"). The GEOMETRIC bbox center is not enough either: these fx are
// TOP-HEAVY (bright mass in the upper rows), so we weight each row by its opaque-pixel
// COUNT and return the mass centroid - anchoring the visible bright band on a point.
// Returns null when the alpha read is impossible (headless / tainted) so callers can
// fall back to cell.h/2. Cached per atlas+pose, same as poseGroundOffset.
export function poseContentMid(atlas, poseName) {
  if (!atlas._cmid) atlas._cmid = Object.create(null);
  const cached = atlas._cmid[poseName];
  if (cached !== undefined) return cached;
  let mid = null;
  const buf = ensureAlphaBuffer(atlas);
  const pose = atlas.poses && (atlas.poses[poseName] || atlas.poses.idle);
  if (buf && pose && pose.cells && pose.cells.length) {
    const { w: cw, h: ch } = atlas.cell;
    const cols = atlas.grid.cols;
    let wSum = 0, mass = 0; // sum(rowIndex * opaqueCount) and sum(opaqueCount)
    for (let i = 0; i < pose.cells.length; i++) {
      const cellIdx = pose.cells[i];
      const col = cellIdx % cols, row = Math.floor(cellIdx / cols);
      const bx = Math.floor(col * cw), by = Math.floor(row * ch);
      const cwi = Math.min(Math.round(cw), buf.w - bx);
      const chi = Math.min(Math.round(ch), buf.h - by);
      for (let ly = 0; ly < chi; ly++) {
        let cnt = 0;
        const base = ((by + ly) * buf.w + bx) * 4 + 3; // +3 -> alpha channel
        for (let lx = 0; lx < cwi; lx++) { if (buf.d[base + lx * 4] > ALPHA_MIN) cnt++; }
        if (cnt > 0) { wSum += ly * cnt; mass += cnt; }
      }
    }
    if (mass > 0) mid = ch - wSum / mass; // px UP from cell bottom to the opaque-mass centroid
  }
  atlas._cmid[poseName] = mid;
  return mid;
}

/**
 * Draw one pose frame, bottom-center anchored at (x,y).
 * opts: { flip:boolean, scale:number=1, alpha:number=1, tint:string|null,
 *         groundToContent:boolean=false, maxDim:number }
 * - groundToContent shifts the draw down so the figure's real feet land on (x,y).
 * - maxDim caps the drawn width/height (px); a NaN/Infinity/<=0 scale is skipped.
 */
export function drawPose(ctx, atlas, poseName, tFrames, x, y, opts) {
  const { flip = false, alpha = 1, tint = null, groundToContent = false, maxDim = 0 } = opts || {};
  const pose = pickPose(atlas, poseName);
  if (!pose || !pose.cells || pose.cells.length === 0) return;

  // FIX E: never let a NaN/Infinity/degenerate scale or alpha reach drawImage.
  let scale = (opts && opts.scale != null) ? opts.scale : 1;
  if (!Number.isFinite(scale) || scale <= 0) return;
  let al = Number.isFinite(alpha) ? alpha : 1;
  if (al <= 0) return; else if (al > 1) al = 1;

  const cellIdx = frameIndexFor(pose, tFrames);
  const { w: cw, h: ch } = atlas.cell;
  const cols = atlas.grid.cols;
  const col = cellIdx % cols;
  const row = Math.floor(cellIdx / cols);
  const sx = col * cw;
  const sy = row * ch;

  const source = tint ? getTintedCanvas(atlas, tint) : atlas.img;
  let dw = cw * scale;
  let dh = ch * scale;
  // FIX E: clamp the drawn size (caller cap, else the absolute sanity cap).
  let cap = ABS_MAX_DIM;
  if (Number.isFinite(maxDim) && maxDim > 0 && maxDim < cap) cap = maxDim;
  const big = dw > dh ? dw : dh;
  if (big > cap) { const k = cap / big; dw *= k; dh *= k; }

  // FIX A: shift down by the (post-clamp) vertical scale times the measured gap.
  const gy = groundToContent ? poseGroundOffset(atlas, poseName) * (dh / ch) : 0;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = al;
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  // bottom-center anchor: draw box spans [-dw/2, -dh+gy] .. [dw/2, gy] relative to (x,y)
  ctx.drawImage(source, sx, sy, cw, ch, -dw / 2, -dh + gy, dw, dh);
  ctx.restore();
}
