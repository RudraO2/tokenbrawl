import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the in-repo fighter sprite sheet.
 *
 *   node --experimental-strip-types apps/web/scripts/build-sprite-sheet.mts
 *
 * ## Why a generator rather than a downloaded sheet
 *
 * Story 4.1 requires CC0 art and forbids the FightingICE / Rumble Fish sprites
 * outright (Dimps grants research use only, with no redistribution licence).
 * The intended CC0 source could not be downloaded in the session that built
 * this, and committing art whose licence file nobody read is precisely the
 * provenance failure `docs/ASSETS.md` exists to prevent.
 *
 * So the art is authored here, in code, which makes it unambiguously
 * licence-clean and reviewable in a diff. It is not a substitute for real
 * sprite art -- `apps/web/src/render/sprite-sheet.ts` loads any sheet that
 * matches the described layout, so dropping in Martial Hero replaces this with
 * no code change.
 *
 * ## Why a skeleton
 *
 * Hand-authoring fifteen poses as pixel grids would be thousands of lines of
 * character art nobody would ever edit. A pose here is eight joint coordinates,
 * rasterised as thick limb segments -- compact enough to read, and enough to
 * give each Commitment Window phase a genuinely different silhouette, which is
 * the entire point. A viewer has to be able to tell startup from recovery at a
 * glance, because that difference is the game.
 */

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 96;

/** Palette indices. Index 0 is transparent; the renderer tints nothing. */
const CLEAR = 0;
const BODY = 1;
const TRIM = 2;
const EDGE = 3;

const PALETTE: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [245, 245, 240, 255], // --tb-ink, the fighter's mass
  [200, 255, 0, 255], // --tb-accent, the striking limb
  [10, 10, 10, 255], // --tb-bg, the outline that makes it read on any ground
];

interface Joint {
  readonly x: number;
  readonly y: number;
}

/**
 * A pose, in frame-local coordinates with the origin at the feet centre.
 *
 * Only eight points, because a fighting-game silhouette is mostly hips,
 * shoulders and the two limbs that matter. `lead` is the striking hand and is
 * drawn in the accent colour, which is what makes reach legible.
 */
interface Pose {
  readonly head: Joint;
  readonly neck: Joint;
  readonly hip: Joint;
  readonly lead: Joint;
  readonly rear: Joint;
  readonly frontFoot: Joint;
  readonly backFoot: Joint;
  /** Thickness of the lead limb. A committed strike is drawn heavier. */
  readonly leadWeight: number;
}

/** A neutral stance every pose is expressed as a departure from. */
const STANCE: Pose = {
  head: { x: 0, y: -78 },
  neck: { x: 0, y: -64 },
  hip: { x: 0, y: -36 },
  lead: { x: 14, y: -52 },
  rear: { x: -12, y: -50 },
  frontFoot: { x: 14, y: 0 },
  backFoot: { x: -14, y: 0 },
  leadWeight: 5,
};

function pose(overrides: Partial<Pose>): Pose {
  return { ...STANCE, ...overrides };
}

/**
 * Every clip, in the order the sheet lays them out: one clip per row, frames
 * left to right. `sprite-sheet.ts` reads the same names, so the two cannot
 * silently disagree about which row is which.
 */
const CLIPS: readonly (readonly [string, readonly Pose[]])[] = [
  [
    'idle',
    [
      pose({}),
      pose({ head: { x: 0, y: -77 }, neck: { x: 0, y: -63 }, lead: { x: 14, y: -51 } }),
      pose({ head: { x: 0, y: -76 }, neck: { x: 0, y: -62 }, hip: { x: 0, y: -35 } }),
      pose({ head: { x: 0, y: -77 }, neck: { x: 0, y: -63 }, lead: { x: 13, y: -52 } }),
    ],
  ],
  [
    'walk',
    [
      pose({ frontFoot: { x: 20, y: 0 }, backFoot: { x: -18, y: 0 }, hip: { x: 1, y: -34 } }),
      pose({ frontFoot: { x: 12, y: 0 }, backFoot: { x: -8, y: 0 }, hip: { x: 2, y: -38 } }),
      pose({ frontFoot: { x: 18, y: 0 }, backFoot: { x: -20, y: 0 }, hip: { x: 1, y: -34 } }),
      pose({ frontFoot: { x: 8, y: 0 }, backFoot: { x: -12, y: 0 }, hip: { x: 0, y: -38 } }),
    ],
  ],
  [
    'block',
    [
      // Both arms in, weight back. Reads as "nothing is coming out of this".
      pose({
        lead: { x: 8, y: -58 },
        rear: { x: 2, y: -54 },
        hip: { x: -4, y: -36 },
        frontFoot: { x: 10, y: 0 },
        leadWeight: 7,
      }),
    ],
  ],
  [
    // Startup: wound up, arm cocked BACK. The opponent's window to walk out.
    'attack-startup',
    [
      pose({ lead: { x: -6, y: -56 }, hip: { x: -3, y: -37 }, leadWeight: 6 }),
      pose({ lead: { x: -10, y: -58 }, hip: { x: -5, y: -37 }, leadWeight: 6 }),
    ],
  ],
  [
    // Active: fully extended. This is the frame that connects.
    'attack-active',
    [
      pose({ lead: { x: 30, y: -54 }, hip: { x: 3, y: -36 }, frontFoot: { x: 20, y: 0 }, leadWeight: 7 }),
      pose({ lead: { x: 34, y: -54 }, hip: { x: 4, y: -36 }, frontFoot: { x: 22, y: 0 }, leadWeight: 7 }),
    ],
  ],
  [
    // Recovery: overextended, dropped guard. Helpless, and it must look it.
    'attack-recovery',
    [
      pose({ lead: { x: 24, y: -40 }, rear: { x: -16, y: -40 }, head: { x: 4, y: -74 }, leadWeight: 5 }),
      pose({ lead: { x: 18, y: -34 }, rear: { x: -16, y: -38 }, head: { x: 6, y: -72 }, leadWeight: 5 }),
    ],
  ],
  [
    // Special startup is longer and lower -- 10 ticks against attack's 4.
    'special-startup',
    [
      pose({ lead: { x: -12, y: -46 }, rear: { x: -18, y: -44 }, hip: { x: -6, y: -32 }, leadWeight: 7 }),
      pose({ lead: { x: -16, y: -42 }, rear: { x: -20, y: -42 }, hip: { x: -8, y: -30 }, leadWeight: 8 }),
      pose({ lead: { x: -18, y: -50 }, rear: { x: -20, y: -46 }, hip: { x: -8, y: -34 }, leadWeight: 8 }),
    ],
  ],
  [
    // Active: the longest reach in the game, and drawn as such.
    'special-active',
    [
      pose({ lead: { x: 40, y: -50 }, hip: { x: 6, y: -36 }, frontFoot: { x: 24, y: 0 }, leadWeight: 9 }),
      pose({ lead: { x: 46, y: -48 }, hip: { x: 8, y: -36 }, frontFoot: { x: 26, y: 0 }, leadWeight: 9 }),
    ],
  ],
  [
    'special-recovery',
    [
      pose({ lead: { x: 28, y: -30 }, rear: { x: -18, y: -34 }, head: { x: 8, y: -70 }, hip: { x: 4, y: -32 }, leadWeight: 5 }),
      pose({ lead: { x: 20, y: -26 }, rear: { x: -18, y: -32 }, head: { x: 10, y: -68 }, hip: { x: 5, y: -30 }, leadWeight: 5 }),
    ],
  ],
  [
    'hit',
    [
      pose({
        head: { x: -10, y: -74 },
        neck: { x: -6, y: -62 },
        lead: { x: 4, y: -44 },
        rear: { x: -18, y: -46 },
        hip: { x: -4, y: -36 },
        backFoot: { x: -20, y: 0 },
      }),
    ],
  ],
  [
    'ko',
    [
      // Flat out. The only pose whose head is below the hip.
      pose({
        head: { x: -26, y: -14 },
        neck: { x: -16, y: -12 },
        hip: { x: 4, y: -10 },
        lead: { x: -8, y: -4 },
        rear: { x: -20, y: -4 },
        frontFoot: { x: 24, y: -6 },
        backFoot: { x: 18, y: -2 },
        leadWeight: 4,
      }),
    ],
  ],
];

const COLUMNS = Math.max(...CLIPS.map(([, frames]) => frames.length));
const SHEET_WIDTH = FRAME_WIDTH * COLUMNS;
const SHEET_HEIGHT = FRAME_HEIGHT * CLIPS.length;

/** Palette-indexed canvas, one byte per pixel. */
const pixels = new Uint8Array(SHEET_WIDTH * SHEET_HEIGHT);

function plot(x: number, y: number, colour: number): void {
  if (x < 0 || y < 0 || x >= SHEET_WIDTH || y >= SHEET_HEIGHT) {
    return;
  }
  pixels[y * SHEET_WIDTH + x] = colour;
}

/** A thick line segment, rasterised as a square brush along a linear walk. */
function limb(ax: number, ay: number, bx: number, by: number, weight: number, colour: number): void {
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
  const half = Math.floor(weight / 2);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(ax + ((bx - ax) * step) / steps);
    const y = Math.round(ay + ((by - ay) * step) / steps);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        plot(x + dx, y + dy, colour);
      }
    }
  }
}

function disc(cx: number, cy: number, radius: number, colour: number): void {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) {
        plot(cx + dx, cy + dy, colour);
      }
    }
  }
}

function drawPose(originX: number, originY: number, shape: Pose): void {
  const px = (joint: Joint): number => originX + FRAME_WIDTH / 2 + joint.x;
  const py = (joint: Joint): number => originY + FRAME_HEIGHT - 4 + joint.y;

  // Legs and torso in body colour; the lead limb in accent so reach reads.
  limb(px(shape.hip), py(shape.hip), px(shape.frontFoot), py(shape.frontFoot), 7, BODY);
  limb(px(shape.hip), py(shape.hip), px(shape.backFoot), py(shape.backFoot), 7, BODY);
  limb(px(shape.neck), py(shape.neck), px(shape.hip), py(shape.hip), 13, BODY);
  limb(px(shape.neck), py(shape.neck), px(shape.rear), py(shape.rear), 5, BODY);
  limb(px(shape.neck), py(shape.neck), px(shape.lead), py(shape.lead), shape.leadWeight, TRIM);
  disc(px(shape.head), py(shape.head), 9, BODY);
}

/**
 * One-pixel outline in the ground colour, so the fighter reads against the
 * arena without relying on a drop shadow. Applied after every pose is drawn,
 * because an outline computed per-limb would show seams where limbs meet.
 */
function outline(): void {
  const source = Uint8Array.from(pixels);
  for (let y = 0; y < SHEET_HEIGHT; y += 1) {
    for (let x = 0; x < SHEET_WIDTH; x += 1) {
      if (source[y * SHEET_WIDTH + x] !== CLEAR) {
        continue;
      }
      const neighbours = [
        source[(y - 1) * SHEET_WIDTH + x],
        source[(y + 1) * SHEET_WIDTH + x],
        source[y * SHEET_WIDTH + (x - 1)],
        source[y * SHEET_WIDTH + (x + 1)],
      ];
      if (neighbours.some((value) => value === BODY || value === TRIM)) {
        plot(x, y, EDGE);
      }
    }
  }
}

for (const [row, [, frames]] of CLIPS.entries()) {
  for (const [column, shape] of frames.entries()) {
    drawPose(column * FRAME_WIDTH, row * FRAME_HEIGHT, shape);
  }
}
outline();

// --- PNG encoding -----------------------------------------------------------
//
// Written out by hand rather than pulled from a dependency: `apps/web` ships
// `vite` and `vitest` and nothing else, and this script runs once to produce a
// committed file. An 8-bit indexed PNG is four chunks and a CRC table.

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SHEET_WIDTH, 0);
ihdr.writeUInt32BE(SHEET_HEIGHT, 4);
ihdr.writeUInt8(8, 8); // bit depth
ihdr.writeUInt8(3, 9); // colour type 3: indexed
ihdr.writeUInt8(0, 10);
ihdr.writeUInt8(0, 11);
ihdr.writeUInt8(0, 12);

const plte = Buffer.from(PALETTE.flatMap(([r, g, b]) => [r, g, b]));
const trns = Buffer.from(PALETTE.map(([, , , a]) => a));

// Filter byte 0 (None) per scanline. The art is flat colour, so no filter beats
// the deflate that follows.
const raw = Buffer.alloc((SHEET_WIDTH + 1) * SHEET_HEIGHT);
for (let y = 0; y < SHEET_HEIGHT; y += 1) {
  raw[y * (SHEET_WIDTH + 1)] = 0;
  raw.set(pixels.subarray(y * SHEET_WIDTH, (y + 1) * SHEET_WIDTH), y * (SHEET_WIDTH + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('PLTE', plte),
  chunk('tRNS', trns),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', new Uint8Array()),
]);

const here = dirname(fileURLToPath(import.meta.url));
const sprites = join(here, '..', 'public', 'sprites');
mkdirSync(sprites, { recursive: true });
writeFileSync(join(sprites, 'fighter.png'), png);

const layout = {
  _comment: [
    'Generated by apps/web/scripts/build-sprite-sheet.mts -- do not hand-edit.',
    'One clip per row, frames left to right. To use a different sheet (Martial',
    'Hero or otherwise), point sprite-sheet.ts at it and describe its rows here;',
    'no rendering code changes.',
  ],
  image: '/sprites/fighter.png',
  frameWidth: FRAME_WIDTH,
  frameHeight: FRAME_HEIGHT,
  clips: Object.fromEntries(
    CLIPS.map(([name, frames], row) => [name, { row, frames: frames.length }]),
  ),
};
writeFileSync(join(sprites, 'fighter.layout.json'), `${JSON.stringify(layout, null, 2)}\n`, 'utf8');

process.stdout.write(
  `Wrote ${String(SHEET_WIDTH)}x${String(SHEET_HEIGHT)} sheet, ${String(CLIPS.length)} clips, ${String(png.length)} bytes\n`,
);
