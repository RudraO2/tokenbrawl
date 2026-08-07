import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SpriteImage } from './sprite-sheet';
import {
  VFX_POSES,
  createVfxSheet,
  validateVfxSheetLayout,
  type VfxPose,
  type VfxSheetLayout,
} from './vfx-sheet';

/**
 * Story 11.2, the sheet half.
 *
 * `juice.ts` decides *what kind* of impact fires, `juice-draw.ts` decides
 * *where* it lands, and this file decides *which pixels* -- three different
 * failure modes wanting three different tests. The ones here are all about the
 * contract a layout has to meet before it is allowed anywhere near the paint
 * path: same-origin, inside its own image, every pose present, and a source
 * rect that clamps rather than running off the end of a strip.
 *
 * The shipped `public/fx/layout.json` is read from disk in the last block. A
 * suite that only ever validated hand-built objects would pass with a broken
 * file on disk, which is precisely the defect class Story 10.1's visual gate
 * exists for and precisely the one a test *can* cover.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SHIPPED_LAYOUT = join(REPO, 'apps', 'web', 'public', 'fx', 'layout.json');

const IMAGE = '/fx/fx_sheet.png';

/** The shipped layout's shape, with one field or one pose swapped out. */
function layoutWith(overrides: Record<string, unknown> = {}): unknown {
  const { poses, ...rest } = overrides;
  return {
    frameWidth: 208,
    frameHeight: 208,
    ...rest,
    poses: {
      spark_l: { image: IMAGE, x: 0, y: 0, frames: 4, holdFrames: 3 },
      spark_h: { image: IMAGE, x: 0, y: 208, frames: 4, holdFrames: 3 },
      ko_burst: { image: IMAGE, x: 0, y: 832, frames: 5, holdFrames: 4 },
      ...((poses as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

/** The real sheet's dimensions: a 5x5 grid of 208px cells. */
const SHEET: SpriteImage = { width: 1_040, height: 1_040 };

function sheetOf(layout: VfxSheetLayout, image: SpriteImage = SHEET): ReturnType<typeof createVfxSheet> {
  return createVfxSheet(new Map([[IMAGE, image]]), layout);
}

describe('a layout is validated before it can reach the paint path', () => {
  it('accepts the shape the shipped file is written in', () => {
    const layout = validateVfxSheetLayout(layoutWith());
    expect(Object.keys(layout.poses).sort()).toStrictEqual([...VFX_POSES].sort());
    expect(layout.poses.ko_burst.holdFrames).toBe(4);
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen(layout.poses)).toBe(true);
  });

  it('rejects a remote image URL (INV-8)', () => {
    // The site must render identically offline and in CI. The offending URL is
    // named in the message, because a layout is hand-edited data and "unusable"
    // with no detail is a message nobody can act on.
    expect(() =>
      validateVfxSheetLayout(
        layoutWith({ poses: { spark_l: { image: 'https://cdn.example/fx.png', x: 0, y: 0, frames: 4, holdFrames: 3 } } }),
      ),
    ).toThrow(/same-origin.*https:\/\/cdn\.example\/fx\.png/);
    expect(() =>
      validateVfxSheetLayout(
        layoutWith({ poses: { spark_h: { image: 'http://cdn.example/fx.png', x: 0, y: 208, frames: 4, holdFrames: 3 } } }),
      ),
    ).toThrow(/same-origin/);
  });

  it('rejects the off-origin spellings that are not http (INV-8)', () => {
    // The two `http` prefixes are the easy half. A protocol-relative `//host`
    // names another origin just as squarely and reads like a path, which is
    // exactly why it is the one that gets typed by accident; `data:` and
    // `blob:` are not third-party but are not the static asset INV-8 promises
    // either. `sprite-sheet.ts` and `backdrop.ts` still check only the two
    // prefixes -- that is pre-existing and is logged as deferred work, not
    // repeated here.
    // The backslash spellings are the same URLs again: the parser normalises
    // `\` to `/` in the authority position of a special scheme, so
    // `\\cdn.example/fx.png` assigned to `img.src` fetches
    // `https://cdn.example/fx.png` from a string that had just passed a
    // same-origin check.
    for (const image of [
      '//cdn.example/fx.png',
      'data:image/png;base64,AAAA',
      'blob:x',
      '\\\\cdn.example/fx.png',
      '/fx\\..\\..\\secret.png',
    ]) {
      expect(() =>
        validateVfxSheetLayout(
          layoutWith({ poses: { spark_l: { image, x: 0, y: 0, frames: 4, holdFrames: 3 } } }),
        ),
      ).toThrow(/same-origin/);
    }
  });

  it('rejects the whitespace spellings the URL parser strips before resolving (INV-8)', () => {
    // The third instance of one bug, and the reason the fix moved from the
    // pattern to the subject. `OFF_ORIGIN`'s arms are anchored with `^`, and
    // WHATWG URL parsing strips leading/trailing spaces and removes tab, LF and
    // CR from *anywhere* before it resolves. So each of these passed an
    // anchored check and then resolved to `https://cdn.example/fx.png` at
    // `img.src` -- the off-origin fetch INV-8 forbids, from a document the
    // validator had just called same-origin.
    for (const image of [
      ' //cdn.example/fx.png',
      '\t//cdn.example/fx.png',
      '\nhttps://cdn.example/fx.png',
      'ht\ntps://cdn.example/fx.png',
      'https://cdn.example/fx.png ',
      '\r\n//cdn.example/fx.png',
    ]) {
      expect(() =>
        validateVfxSheetLayout(
          layoutWith({ poses: { spark_l: { image, x: 0, y: 0, frames: 4, holdFrames: 3 } } }),
        ),
      ).toThrow(/same-origin/);
    }
  });

  it('names the offending string with its whitespace visible', () => {
    // A message reading `must be same-origin, got  //cdn.example/fx.png` is a
    // message that hides the one character that mattered. The value is quoted,
    // so a leading space or an embedded newline is legible in a console.
    expect(() =>
      validateVfxSheetLayout(
        layoutWith({
          poses: { spark_l: { image: ' /fx/fx_sheet.png', x: 0, y: 0, frames: 4, holdFrames: 3 } },
        }),
      ),
    ).toThrow(/same-origin, got " \/fx\/fx_sheet\.png"/);
  });

  it('rejects a non-square cell, because one size is drawn on both axes', () => {
    // `juice-draw.ts` passes `impactSizePx` as both destination dimensions, so
    // a 208x104 cell would silently render stretched to a square. Refused
    // loudly at validation rather than supported badly at paint time.
    expect(() => validateVfxSheetLayout(layoutWith({ frameHeight: 104 }))).toThrow(
      /frameWidth \(208\) and frameHeight \(104\) must match/,
    );
  });

  it('rejects a missing pose rather than silently substituting another', () => {
    // The failure this guards is invisible on screen: a sheet missing
    // `ko_burst` that fell back to `spark_l` would draw the Match's last hit
    // exactly like its first, which is the one thing the KO pose exists to
    // stop, and nothing would report it.
    const poses = {
      spark_l: { image: IMAGE, x: 0, y: 0, frames: 4, holdFrames: 3 },
      spark_h: { image: IMAGE, x: 0, y: 208, frames: 4, holdFrames: 3 },
    };
    expect(() => validateVfxSheetLayout({ frameWidth: 208, frameHeight: 208, poses })).toThrow(
      /no layout for pose "ko_burst"/,
    );
  });

  it('rejects a non-positive or non-integer count anywhere it matters', () => {
    for (const bad of [0, -1, 2.5, '4', null]) {
      expect(() =>
        validateVfxSheetLayout(
          layoutWith({ poses: { spark_l: { image: IMAGE, x: 0, y: 0, frames: bad, holdFrames: 3 } } }),
        ),
      ).toThrow(/frames must be a positive safe integer/);
      expect(() =>
        validateVfxSheetLayout(
          layoutWith({ poses: { spark_l: { image: IMAGE, x: 0, y: 0, frames: 4, holdFrames: bad } } }),
        ),
      ).toThrow(/holdFrames must be a positive safe integer/);
    }
    // `holdFrames: 0` in particular would divide by zero in `frameFor`, which
    // is why it is caught here rather than defended against there.
    expect(() => validateVfxSheetLayout(layoutWith({ frameWidth: 0 }))).toThrow(/frameWidth/);
    expect(() => validateVfxSheetLayout(layoutWith({ frameHeight: -8 }))).toThrow(/frameHeight/);
  });

  it('rejects a document that is not an object at all', () => {
    for (const bad of [null, [], 'layout', 7]) {
      expect(() => validateVfxSheetLayout(bad)).toThrow(/Impact FX layout is unusable/);
    }
  });
});

describe('a sheet is bounds-checked once, at creation', () => {
  it('rejects a pose that overruns the image, naming the pose and both bounds', () => {
    const layout = validateVfxSheetLayout(
      layoutWith({ poses: { ko_burst: { image: IMAGE, x: 0, y: 832, frames: 9, holdFrames: 4 } } }),
    );
    expect(() => sheetOf(layout)).toThrow(/pose "ko_burst" needs 1872x1040 of "\/fx\/fx_sheet\.png", which is 1040x1040/);
  });

  it('rejects a pose whose row falls off the bottom of the image', () => {
    const layout = validateVfxSheetLayout(
      layoutWith({ poses: { ko_burst: { image: IMAGE, x: 0, y: 1_000, frames: 5, holdFrames: 4 } } }),
    );
    expect(() => sheetOf(layout)).toThrow(/pose "ko_burst" needs/);
  });

  it('rejects a layout whose image never decoded', () => {
    const layout = validateVfxSheetLayout(layoutWith());
    expect(() => createVfxSheet(new Map(), layout)).toThrow(/no image was loaded for "\/fx\/fx_sheet\.png"/);
  });

  it('reports every distinct image the layout names', () => {
    const sheet = sheetOf(validateVfxSheetLayout(layoutWith()));
    // One file, named once, however many poses read from it.
    expect(sheet.imageUrls).toStrictEqual([IMAGE]);
    expect(sheet.imageFor(IMAGE)).toBe(SHEET);
    expect(sheet.imageFor('/fx/nothing.png')).toBeUndefined();
  });
});

describe('frameFor advances on holdFrames and clamps at the end', () => {
  const sheet = sheetOf(validateVfxSheetLayout(layoutWith()));

  it('picks a different source rect per pose, so a grade is visible', () => {
    // The acceptance criterion, at the layer that decides it: a light hit and a
    // heavy hit must not read from the same pixels.
    const light = sheet.frameFor('spark_l', 0);
    const heavy = sheet.frameFor('spark_h', 0);
    const ko = sheet.frameFor('ko_burst', 0);
    expect(light.sy).toBe(0);
    expect(heavy.sy).toBe(208);
    expect(ko.sy).toBe(832);
    expect(new Set([light.sy, heavy.sy, ko.sy]).size).toBe(3);
    for (const cell of [light, heavy, ko]) {
      expect(cell.sw).toBe(208);
      expect(cell.sh).toBe(208);
      expect(cell.sx).toBe(0);
    }
  });

  it('holds each atlas frame for exactly holdFrames clock frames', () => {
    // 4 cells held 3 clock frames each: ages 0-2 read cell 0, 3-5 cell 1, and
    // so on. That mapping is the whole of "never on a wall clock" -- the input
    // is an integer count of callbacks and nothing else.
    const columns = Array.from({ length: 12 }, (_unused, age) => sheet.frameFor('spark_l', age).sx / 208);
    expect(columns).toStrictEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);

    // `ko_burst` is 5 cells held 4 each -- a different rhythm, from the same
    // arithmetic.
    const koColumns = Array.from({ length: 20 }, (_unused, age) => sheet.frameFor('ko_burst', age).sx / 208);
    expect(koColumns.filter((column) => column === 0)).toHaveLength(4);
    expect(koColumns[19]).toBe(4);
  });

  it('clamps past the end of a pose rather than reading off the strip', () => {
    // The I/O matrix's "impact outlives its pose" row. Clamp, never throw: a
    // throw here would abort the animation-frame callback and freeze playback
    // on whatever was last painted.
    const last = sheet.frameFor('spark_l', 11);
    for (const age of [12, 60, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(sheet.frameFor('spark_l', age)).toStrictEqual(last);
    }
    expect(last.sx + last.sw).toBeLessThanOrEqual(SHEET.width);
  });

  it('clamps a negative age to the first frame, and floors a fractional one', () => {
    // Two different behaviours, and the earlier version of this case conflated
    // them: it asserted `2.9` reads cell 0, which is true because `2.9 / 3`
    // floors to 0 and not because a fraction is clamped. `3.5` reads cell 1.
    // The track only ever hands over integers; this pins what happens if a
    // later story stops doing that, rather than implying a guarantee.
    const first = sheet.frameFor('spark_h', 0);
    expect(sheet.frameFor('spark_h', -5)).toStrictEqual(first);
    expect(sheet.frameFor('spark_h', -0.5)).toStrictEqual(first);
    expect(sheet.frameFor('spark_h', 2.9)).toStrictEqual(first);
    expect(sheet.frameFor('spark_h', 3.5).sx / 208).toBe(1);
    expect(sheet.frameFor('spark_h', 11.9).sx / 208).toBe(3);
  });

  it('clamps a non-finite age instead of propagating it into the source rect', () => {
    // `Math.max`/`Math.min` do not clamp `NaN`, they propagate it: a `NaN` age
    // walks through both and out into `sx`, and `drawImage` with a `NaN` source
    // rect draws *nothing* and reports nothing. That is the one way to break
    // "clamped, never out of bounds" without a number ever leaving the strip,
    // so it reads the first cell rather than a rect made of `NaN`.
    const first = sheet.frameFor('spark_l', 0);
    for (const age of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const cell = sheet.frameFor('spark_l', age);
      expect(Number.isFinite(cell.sx)).toBe(true);
      expect(Number.isFinite(cell.sy)).toBe(true);
    }
    expect(sheet.frameFor('spark_l', Number.NaN)).toStrictEqual(first);
    // The infinities are *not* routed through zero: they are ordinary
    // out-of-range ages and the existing clamps already put them on the right
    // cell. Sending `+Infinity` to the first frame would be the wrong picture,
    // arrived at quietly, in the name of safety.
    expect(sheet.frameFor('spark_l', Number.NEGATIVE_INFINITY)).toStrictEqual(first);
    expect(sheet.frameFor('spark_l', Number.POSITIVE_INFINITY)).toStrictEqual(
      sheet.frameFor('spark_l', 11),
    );
  });

  it('keeps its own copy of the images it was bounds-checked against', () => {
    // The bounds run once, at creation. If the sheet read through to the
    // caller's map, a later `set` of a smaller image would send `drawImage` a
    // source rect past the end of it -- and `ReadonlyMap` is a compile-time
    // view of a runtime-mutable object, so nothing but this copy stops it.
    const images = new Map([[IMAGE, SHEET]]);
    const sheetOfMutable = createVfxSheet(images, validateVfxSheetLayout(layoutWith()));
    images.set(IMAGE, { width: 8, height: 8 } as unknown as typeof SHEET);
    expect(sheetOfMutable.imageFor(IMAGE)).toBe(SHEET);
  });

  it('reports each pose whole life as frames x holdFrames', () => {
    expect(sheet.lifeFramesFor('spark_l')).toBe(12);
    expect(sheet.lifeFramesFor('spark_h')).toBe(12);
    expect(sheet.lifeFramesFor('ko_burst')).toBe(20);
  });
});

describe('the shipped layout on disk is one this loader accepts', () => {
  it('validates, and every pose fits inside the 1040x1040 sheet', () => {
    // Read from disk rather than rebuilt here. Everything above would pass
    // with a broken `public/fx/layout.json`; this is the case that would not.
    const layout = validateVfxSheetLayout(JSON.parse(readFileSync(SHIPPED_LAYOUT, 'utf8')));
    const sheet = sheetOf(layout);

    for (const pose of VFX_POSES) {
      const entry = layout.poses[pose as VfxPose];
      expect(entry.image).toBe(IMAGE);
      expect(entry.x + layout.frameWidth * entry.frames).toBeLessThanOrEqual(SHEET.width);
      expect(entry.y + layout.frameHeight).toBeLessThanOrEqual(SHEET.height);
      expect(sheet.lifeFramesFor(pose as VfxPose)).toBe(entry.frames * entry.holdFrames);
    }
  });

  it('places every pose on the grid cell the source atlas puts it on', () => {
    // Cell `i` sits at `(i % 5 * 208, floor(i / 5) * 208)`. `spark_l` is cells
    // 0-3, `spark_h` 5-8, `ko_burst` 20-24 -- so all three start in column 0,
    // on rows 0, 1 and 4. This is the arithmetic that was done by hand when
    // the layout was authored, checked.
    const layout = validateVfxSheetLayout(JSON.parse(readFileSync(SHIPPED_LAYOUT, 'utf8')));
    const cellOf = (index: number): { x: number; y: number } => ({
      x: (index % 5) * 208,
      y: Math.floor(index / 5) * 208,
    });
    for (const [pose, firstCell, frames] of [
      ['spark_l', 0, 4],
      ['spark_h', 5, 4],
      ['ko_burst', 20, 5],
    ] as const) {
      const entry = layout.poses[pose];
      expect({ x: entry.x, y: entry.y }).toStrictEqual(cellOf(firstCell));
      expect(entry.frames).toBe(frames);
      // Contiguous and inside one row, which is why this is a strip and not an
      // atlas port: the last cell must not wrap onto the next row.
      expect(Math.floor((firstCell + frames - 1) / 5)).toBe(Math.floor(firstCell / 5));
    }
  });

  it('names no remote host and carries exactly one timing number per pose', () => {
    const raw = readFileSync(SHIPPED_LAYOUT, 'utf8');
    expect(raw).not.toMatch(/https?:\/\//);
    const layout = validateVfxSheetLayout(JSON.parse(raw));
    for (const pose of VFX_POSES) {
      // `holdFrames` is the only timing field in the file. An `fps`, a `ms` or
      // a `duration` here would be the source atlas's playback clock arriving
      // by the back door (INV-1, INV-3).
      const entry = layout.poses[pose as VfxPose] as unknown as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toStrictEqual(['frames', 'holdFrames', 'image', 'x', 'y']);
    }
    expect(raw).not.toMatch(/\b(fps|ms|duration|seconds)\b/);
  });
});
