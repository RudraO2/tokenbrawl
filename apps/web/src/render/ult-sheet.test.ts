import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROSTER_IDS, type RosterId } from './roster';
import type { SpriteImage } from './sprite-sheet';
import {
  ULT_PARTS,
  createUltSheet,
  imageUrlsFor,
  validateUltSheetLayout,
  type UltSheetLayout,
} from './ult-sheet';

/**
 * Story 11.4. The Ultimate's per-character art, and the two failures it has to
 * tell apart.
 *
 * A **malformed layout** is a typo in a file authored in this repo beside the
 * image it describes, and is refused loudly. A **missing image** is the network,
 * and drops one fighter while everybody else keeps their art. The suite is
 * mostly about that distinction, because getting it backwards either hides a
 * typo behind a fighter who silently lost their beam, or takes the whole
 * cinematic down because one portrait 404'd.
 *
 * The shipped `public/fx/ult-layout.json` is read from disk in the last block.
 * A layout this file wrote itself would agree with itself forever.
 */

const SHIPPED_LAYOUT = join(process.cwd(), 'public', 'fx', 'ult-layout.json');
const ATLAS = '/fx/fx_ult.png';

function cellFor(index: number): { readonly x: number; readonly y: number } {
  return { x: (index % 5) * 208, y: Math.floor(index / 5) * 208 };
}

/** A minimal well-formed document, with `fighters` swapped in per case. */
function documentWith(fighters: Record<string, unknown>): unknown {
  return { cellWidth: 208, cellHeight: 208, fighters };
}

function fighterEntry(id: string, firstCell: number): Record<string, unknown> {
  return {
    portrait: `/portraits/${id}.png`,
    parts: {
      muzzle: { image: ATLAS, ...cellFor(firstCell) },
      beam: { image: ATLAS, ...cellFor(firstCell + 1) },
      impact: { image: ATLAS, ...cellFor(firstCell + 2) },
    },
  };
}

function imagesFor(
  urls: readonly string[],
  size: { width: number; height: number } = { width: 1_040, height: 1_040 },
): Map<string, SpriteImage> {
  return new Map(urls.map((url) => [url, size]));
}

describe('the Ultimate FX layout is validated before it is bound', () => {
  it('accepts a document with one fighter, and types it', () => {
    const layout = validateUltSheetLayout(documentWith({ clawde: fighterEntry('clawde', 0) }));
    expect(layout.cellWidth).toBe(208);
    expect(layout.fighters.clawde?.parts.beam).toStrictEqual({ image: ATLAS, x: 208, y: 0 });
    expect(layout.fighters.chatty).toBeUndefined();
  });

  it('accepts a document with no fighters at all', () => {
    // An empty roster is a sheet that binds nothing, which is the same picture
    // as no sheet -- a degrade, not a corruption.
    expect(validateUltSheetLayout(documentWith({})).fighters).toStrictEqual({});
  });

  it('refuses a fighter this project has no art for', () => {
    // The source atlas carries eight fighters and `public/` holds four.
    // Admitting a fifth would put a fighter in `fighters` whose every image
    // lookup then fails, which is a silent no-op rather than a loud one.
    expect(() => validateUltSheetLayout(documentWith({ pilot: fighterEntry('pilot', 12) }))).toThrow(
      /roster/,
    );
  });

  it('refuses a half-present fighter rather than binding the parts that are there', () => {
    // A beam with no muzzle is invisible rather than obviously wrong, and this
    // file is authored here -- so a missing key is a typo to be told about.
    for (const missing of ULT_PARTS) {
      const entry = fighterEntry('clawde', 0);
      delete (entry.parts as Record<string, unknown>)[missing];
      expect(() => validateUltSheetLayout(documentWith({ clawde: entry }))).toThrow(
        new RegExp(missing),
      );
    }
    const noPortrait = fighterEntry('clawde', 0);
    delete noPortrait.portrait;
    expect(() => validateUltSheetLayout(documentWith({ clawde: noPortrait }))).toThrow(/portrait/);
  });

  it('refuses every spelling of an off-origin asset (INV-8)', () => {
    // The three spellings `vfx-sheet.ts` enumerates, plus the two that only
    // differ once the URL parser has normalised the string: a leading space and
    // an embedded newline both resolve to a remote host while an anchored
    // pattern tested against the raw text sees neither.
    for (const image of [
      'https://cdn.example/fx_ult.png',
      '//cdn.example/fx_ult.png',
      '\\\\cdn.example\\fx_ult.png',
      ' //cdn.example/fx_ult.png',
      'ht\ntps://cdn.example/fx_ult.png',
      'data:image/png;base64,AAAA',
    ]) {
      const entry = fighterEntry('clawde', 0);
      (entry.parts as Record<string, Record<string, unknown>>).beam.image = image;
      expect(() => validateUltSheetLayout(documentWith({ clawde: entry }))).toThrow(
        /same-origin/,
      );

      const portraitEntry = fighterEntry('clawde', 0);
      portraitEntry.portrait = image;
      expect(() => validateUltSheetLayout(documentWith({ clawde: portraitEntry }))).toThrow(
        /same-origin/,
      );
    }
  });

  it('refuses a non-integer, negative or absent dimension', () => {
    for (const bad of [0, -1, 1.5, '208', null, undefined, Number.NaN]) {
      expect(() => validateUltSheetLayout({ ...(documentWith({}) as object), cellWidth: bad })).toThrow();
      expect(() => validateUltSheetLayout({ ...(documentWith({}) as object), cellHeight: bad })).toThrow();
    }
    const entry = fighterEntry('clawde', 0);
    (entry.parts as Record<string, Record<string, unknown>>).beam.x = -1;
    expect(() => validateUltSheetLayout(documentWith({ clawde: entry }))).toThrow();
  });

  it('refuses anything that is not an object of objects', () => {
    for (const bad of [null, 42, 'clawde', [], [1, 2]]) {
      expect(() => validateUltSheetLayout(bad)).toThrow(/unusable/);
    }
    expect(() => validateUltSheetLayout({ cellWidth: 208, cellHeight: 208 })).toThrow(/fighters/);
    expect(() => validateUltSheetLayout(documentWith({ clawde: 7 }))).toThrow(/object/);
  });
});

describe('binding a layout to the images that actually decoded', () => {
  const twoFighters = (): UltSheetLayout =>
    validateUltSheetLayout(
      documentWith({ clawde: fighterEntry('clawde', 0), chatty: fighterEntry('chatty', 3) }),
    );

  it('resolves every part to a source rect on the image itself', () => {
    const layout = twoFighters();
    const sheet = createUltSheet(imagesFor(imageUrlsFor(layout, ROSTER_IDS)), layout);
    expect([...sheet.fighters]).toStrictEqual(['clawde', 'chatty']);

    const beam = sheet.partFor('clawde', 'beam');
    expect(beam).toStrictEqual({
      image: { width: 1_040, height: 1_040 },
      sx: 208,
      sy: 0,
      sw: 208,
      sh: 208,
    });
    // Two fighters, two different rects. This is the assertion that "per
    // character" is a fact rather than a claim.
    expect(sheet.partFor('chatty', 'beam')?.sx).not.toBe(beam?.sx);
  });

  it('resolves a portrait as the whole image rather than as a cell', () => {
    const layout = twoFighters();
    const images = imagesFor(imageUrlsFor(layout, ROSTER_IDS));
    images.set('/portraits/clawde.png', { width: 512, height: 512 });
    const portrait = createUltSheet(images, layout).portraitFor('clawde');
    expect(portrait).toStrictEqual({
      image: { width: 512, height: 512 },
      sx: 0,
      sy: 0,
      sw: 512,
      sh: 512,
    });
  });

  it('drops one fighter for a missing image and keeps the rest', () => {
    // The network failure, not the typo. Only `chatty` names the second atlas,
    // so only `chatty` goes.
    const layout = validateUltSheetLayout(
      documentWith({
        clawde: fighterEntry('clawde', 0),
        chatty: {
          portrait: '/portraits/chatty.png',
          parts: {
            muzzle: { image: '/fx/other.png', x: 0, y: 0 },
            beam: { image: '/fx/other.png', x: 208, y: 0 },
            impact: { image: '/fx/other.png', x: 416, y: 0 },
          },
        },
      }),
    );
    const sheet = createUltSheet(
      imagesFor([ATLAS, '/portraits/clawde.png', '/portraits/chatty.png']),
      layout,
    );
    expect([...sheet.fighters]).toStrictEqual(['clawde']);
    expect(sheet.partFor('chatty', 'beam')).toBeUndefined();
    expect(sheet.partFor('clawde', 'beam')).toBeDefined();
    // Their portrait still resolves: the two are separate files and are dropped
    // separately, so a fighter can have a picture and no beam or the reverse.
    expect(sheet.portraitFor('chatty')).toBeDefined();
  });

  it('drops a portrait without dropping the parts beside it', () => {
    const layout = twoFighters();
    const sheet = createUltSheet(imagesFor([ATLAS]), layout);
    expect([...sheet.fighters]).toStrictEqual(['clawde', 'chatty']);
    expect(sheet.portraitFor('clawde')).toBeUndefined();
    expect(sheet.partFor('clawde', 'impact')).toBeDefined();
  });

  it('drops a fighter whose cell overruns its image, rather than drawing nothing', () => {
    // `drawImage` with a source rect past the end of an image draws nothing and
    // reports nothing, which is the one failure a call-sequence assertion
    // cannot see. Checked once, here, before it can reach the paint path.
    const layout = twoFighters();
    const sheet = createUltSheet(imagesFor(imageUrlsFor(layout, ROSTER_IDS), { width: 300, height: 300 }), layout);
    expect([...sheet.fighters]).toStrictEqual([]);
    for (const id of ROSTER_IDS) {
      for (const part of ULT_PARTS) {
        expect(sheet.partFor(id, part)).toBeUndefined();
      }
    }
  });

  it('answers undefined for a fighter the layout never mentioned', () => {
    const layout = validateUltSheetLayout(documentWith({ clawde: fighterEntry('clawde', 0) }));
    const sheet = createUltSheet(imagesFor(imageUrlsFor(layout, ROSTER_IDS)), layout);
    expect(sheet.partFor('grokk', 'beam')).toBeUndefined();
    expect(sheet.portraitFor('grokk')).toBeUndefined();
  });

  it('cannot be undermined by a caller who kept the map it was handed', () => {
    // `ReadonlyMap` is a compile-time view of a runtime-mutable object, and the
    // bounds run exactly once: a caller that swapped in a smaller image
    // afterwards would otherwise hand `drawImage` a rect past the end of it.
    const layout = twoFighters();
    const images = imagesFor(imageUrlsFor(layout, ROSTER_IDS));
    const sheet = createUltSheet(images, layout);
    images.set(ATLAS, { width: 1, height: 1 });
    expect(sheet.partFor('clawde', 'beam')?.image).toStrictEqual({ width: 1_040, height: 1_040 });
  });

  it('fetches only the fighters in play, deduplicated', () => {
    const layout = twoFighters();
    // Both fighters share one atlas, so four files rather than eight.
    expect([...imageUrlsFor(layout, ['clawde', 'chatty'])]).toStrictEqual([
      '/portraits/clawde.png',
      ATLAS,
      '/portraits/chatty.png',
    ]);
    // And a pair that is only half present asks for half as much.
    expect([...imageUrlsFor(layout, ['clawde', 'grokk'])]).toStrictEqual([
      '/portraits/clawde.png',
      ATLAS,
    ]);
    expect([...imageUrlsFor(layout, [])]).toStrictEqual([]);
  });
});

describe('the shipped layout describes the art that is actually in public/', () => {
  it('gives every fighter in the roster all three parts and a portrait', () => {
    const layout = validateUltSheetLayout(JSON.parse(readFileSync(SHIPPED_LAYOUT, 'utf8')));
    expect(Object.keys(layout.fighters).sort()).toStrictEqual([...ROSTER_IDS].sort());
    for (const id of ROSTER_IDS) {
      expect(layout.fighters[id]?.portrait).toBe(`/portraits/${id}.png`);
      for (const part of ULT_PARTS) {
        expect(layout.fighters[id]?.parts[part].image).toBe(ATLAS);
      }
    }
  });

  it('places every cell on the grid cell the source atlas puts it on', () => {
    // Cell `i` sits at `(i % 5 * 208, floor(i / 5) * 208)`, and the atlas
    // assigns each fighter three consecutive cells starting at `index * 3`.
    // This is the arithmetic that was done by hand when the layout was
    // authored, checked -- including the two entries that wrap onto the next
    // row, which is where a hand-copied grid goes wrong.
    const layout = validateUltSheetLayout(JSON.parse(readFileSync(SHIPPED_LAYOUT, 'utf8')));
    for (const [index, id] of ROSTER_IDS.entries()) {
      for (const [offset, part] of ULT_PARTS.entries()) {
        expect(layout.fighters[id as RosterId]?.parts[part]).toStrictEqual({
          image: ATLAS,
          ...cellFor(index * ULT_PARTS.length + offset),
        });
      }
    }
    // Two of the twelve really do wrap, so the case above is not vacuous.
    const wrapped = ROSTER_IDS.flatMap((id) =>
      ULT_PARTS.map((part) => layout.fighters[id as RosterId]?.parts[part].y ?? 0),
    ).filter((y) => y > 0);
    expect(wrapped.length).toBeGreaterThan(0);
  });

  it('names no remote host and carries no timing field at all', () => {
    const raw = readFileSync(SHIPPED_LAYOUT, 'utf8');
    expect(raw).not.toMatch(/https?:\/\//);
    // Every ult pose in the source atlas is a single cell at `fps: 1`. An
    // `fps`, a `ms` or a `duration` here would be a playback clock arriving by
    // the back door (INV-1, INV-3) -- and would be describing nothing.
    expect(raw).not.toMatch(/\b(fps|ms|duration|seconds|frames|holdFrames)\b/);
    const layout = validateUltSheetLayout(JSON.parse(raw));
    for (const id of ROSTER_IDS) {
      for (const part of ULT_PARTS) {
        expect(Object.keys(layout.fighters[id]?.parts[part] ?? {}).sort()).toStrictEqual([
          'image',
          'x',
          'y',
        ]);
      }
    }
  });

  it('names the reference project nowhere', () => {
    // `public/` may carry the copied bytes and may not carry the name, in a
    // filename or in file contents (Story 9.1 / AD-16, restated in
    // `docs/DEV-REFERENCE.md`). The sweep in
    // `packages/cli/src/extraction-exclusion.test.ts` is the repo-wide one;
    // this is the same rule asserted where the file is described.
    const raw = readFileSync(SHIPPED_LAYOUT, 'utf8');
    expect(raw.toLowerCase()).not.toContain('extraction');
    expect(raw).not.toMatch(/[A-Za-z]:\\/);
  });
});
