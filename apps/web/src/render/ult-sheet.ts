import { ROSTER_IDS, isRosterId, type RosterId } from './roster';
import type { SpriteImage } from './sprite-sheet';

/**
 * Story 11.4: the Ultimate's per-character art, and why it is a second sheet.
 *
 * Three cells per fighter -- `muzzle`, `beam`, `impact` -- out of the
 * reference's `fx_ult` atlas, plus that fighter's painted portrait. Same owner,
 * same basis and same treatment as every sprite pack and audio cue already in
 * `apps/web/public/`: the bytes were copied, the provenance is in
 * `docs/ASSETS.md`, and nothing else travelled with them.
 *
 * ## Why not extend `vfx-sheet.ts`
 *
 * `VfxSheetLayout` is a *strip* layout -- `{x, y, frames, holdFrames}` -- and
 * requires every pose in `VFX_POSES` to be present, because a half-present
 * impact sheet that silently drew a KO with the light spark would be worse than
 * no sheet at all. Neither property fits here:
 *
 * - **Nothing animates.** Every ult pose in the source atlas is a single cell at
 *   `fps: 1`, so `frames` and `holdFrames` would both be a constant `1` in every
 *   entry -- two timing fields carried purely to be ignored, in a repo whose
 *   layout files are swept for exactly that (INV-1, INV-3).
 * - **Absence is legal here and illegal there.** Story 11.4's acceptance
 *   criterion is that a fighter with no portrait or no ult art still throws the
 *   Ultimate without throwing. A partially-bound sheet is the *designed* state,
 *   not a corruption.
 *
 * So the two live side by side and neither is bent to fit the other. What is
 * shared is the *shape*: the same `parsedAs` normalisation, the same
 * `OFF_ORIGIN` refusal, the same bounds-checked-once-at-creation rule, for the
 * same reasons written out there.
 *
 * ## Where absence is tolerated, exactly
 *
 * Two different failures, deliberately handled two different ways:
 *
 * - **A malformed layout is refused.** This file is authored in this repo beside
 *   the image it describes, so a typo in it is a mistake to be told about
 *   loudly rather than a fighter quietly losing their beam. `startup.ts` catches
 *   the throw, warns once, and the whole cinematic degrades to Story 10.4's
 *   banner-and-band -- which is the outermost fallback and is meant to be.
 * - **An image that did not decode drops its fighter.** The layout was fine and
 *   the network was not; that fighter falls out of `fighters` and every lookup
 *   for them answers `undefined`, while everybody whose art did arrive keeps
 *   theirs. This is what makes "a fighter with no portrait still throws it"
 *   true per fighter rather than per page.
 *
 * The portrait and the parts are dropped independently, because they are
 * separate files: a fighter whose beam decoded and whose portrait 404'd draws
 * the beam and takes the banner in place of the portrait.
 */

/** The three things a fighter's Ultimate is drawn out of. */
export const ULT_PARTS = ['muzzle', 'beam', 'impact'] as const;

export type UltPart = (typeof ULT_PARTS)[number];

/** One cell of the atlas. No frame count and no hold: every ult pose is a single cell. */
export interface UltCell {
  readonly image: string;
  readonly x: number;
  readonly y: number;
}

export interface UltFighterLayout {
  /** A whole image, not a cell -- portraits are separate files at their own size. */
  readonly portrait: string;
  readonly parts: Readonly<Record<UltPart, UltCell>>;
}

export interface UltSheetLayout {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly fighters: Readonly<Partial<Record<RosterId, UltFighterLayout>>>;
}

/**
 * A source rectangle with its image already resolved.
 *
 * `VfxFrame` carries the image *url* and makes the caller look it up, because
 * `paintImpacts` is inside a loop that would otherwise repeat the lookup per
 * spark. Here the caller draws at most three rectangles a frame and every one
 * of them needs the image, so resolving once at the boundary removes a second
 * `undefined` the drawing path would have to branch on.
 */
export interface UltFrame {
  readonly image: SpriteImage;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

export interface UltSheet {
  /** The fighters whose parts are all bound, in roster order. */
  readonly fighters: readonly RosterId[];
  /** Every distinct image this sheet ended up bound to, deduplicated. */
  readonly imageUrls: readonly string[];
  partFor(id: RosterId, part: UltPart): UltFrame | undefined;
  portraitFor(id: RosterId): UltFrame | undefined;
}

function fail(detail: string): never {
  throw new Error(`Ultimate FX layout is unusable: ${detail}`);
}

/**
 * Any absolute reference, in all three spellings `vfx-sheet.ts` enumerates: a
 * scheme, a protocol-relative authority, or either written with backslashes.
 */
const OFF_ORIGIN = /^[a-z][a-z0-9+.-]*:|^\/\/|\\/i;

/**
 * The string the URL parser will actually see.
 *
 * WHATWG URL parsing strips leading and trailing C0-and-space and removes tab,
 * LF and CR from anywhere before it resolves anything, so an anchored pattern
 * tested against the raw text sees a different string from the one `img.src`
 * fetches. Normalising the subject rather than widening the pattern is the fix
 * `vfx-sheet.ts` arrived at after three rounds of the same bug; it is copied
 * here rather than re-derived.
 */
function parsedAs(image: string): string {
  return image.replace(/[\t\n\r]/g, '').trim();
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${where} must be a positive safe integer, got ${String(value)}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${where} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value as number;
}

function sameOriginPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${where} must be a non-empty string`);
  }
  const resolved = parsedAs(value);
  if (resolved !== value || OFF_ORIGIN.test(resolved)) {
    // INV-8. The site must render identically offline and in CI, and a
    // third-party host is a dependency someone else can withdraw. A path that
    // normalises to something other than itself is refused on its own terms:
    // admitting one would mean this function validates a different string from
    // the one `img.src` fetches, which is the hole independent of what the
    // difference spells.
    fail(`${where} must be same-origin, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validates a layout document and returns it typed.
 *
 * A fighter may be **absent** -- that is the designed degrade -- but a fighter
 * that is *present* must be complete: all three parts and a portrait. A half
 * entry is a typo in a file authored beside the art, and drawing a beam with no
 * muzzle would be invisible rather than obviously wrong.
 *
 * Keys outside `ROSTER_IDS` are refused rather than ignored. The source atlas
 * carries eight fighters and this project ships four; a document naming one of
 * the other four describes art that is not in `public/`, and admitting it would
 * put a fighter in `fighters` whose every image lookup then fails.
 */
export function validateUltSheetLayout(candidate: unknown): UltSheetLayout {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    fail('the document is not an object');
  }

  const layout = candidate as Record<string, unknown>;
  const cellWidth = positiveInteger(layout.cellWidth, 'cellWidth');
  const cellHeight = positiveInteger(layout.cellHeight, 'cellHeight');

  if (typeof layout.fighters !== 'object' || layout.fighters === null) {
    fail('`fighters` must be an object');
  }
  const fighters = layout.fighters as Record<string, unknown>;

  const validated: Partial<Record<RosterId, UltFighterLayout>> = {};
  for (const [id, entry] of Object.entries(fighters)) {
    if (!isRosterId(id)) {
      fail(`"${id}" is not a fighter in this project's roster`);
    }
    if (typeof entry !== 'object' || entry === null) {
      fail(`fighters.${id} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const portrait = sameOriginPath(record.portrait, `fighters.${id}.portrait`);

    if (typeof record.parts !== 'object' || record.parts === null) {
      fail(`fighters.${id}.parts must be an object`);
    }
    const parts = record.parts as Record<string, unknown>;

    const validatedParts: Partial<Record<UltPart, UltCell>> = {};
    for (const part of ULT_PARTS) {
      const cell = parts[part];
      if (typeof cell !== 'object' || cell === null) {
        fail(`no cell for fighters.${id}.parts.${part}`);
      }
      const cellRecord = cell as Record<string, unknown>;
      validatedParts[part] = Object.freeze({
        image: sameOriginPath(cellRecord.image, `fighters.${id}.parts.${part}.image`),
        x: nonNegativeInteger(cellRecord.x, `fighters.${id}.parts.${part}.x`),
        y: nonNegativeInteger(cellRecord.y, `fighters.${id}.parts.${part}.y`),
      });
    }

    validated[id] = Object.freeze({
      portrait,
      parts: Object.freeze(validatedParts) as Readonly<Record<UltPart, UltCell>>,
    });
  }

  return Object.freeze({
    cellWidth,
    cellHeight,
    fighters: Object.freeze(validated),
  });
}

/**
 * Every image the given fighters need, deduplicated, in a stable order.
 *
 * The roster is a parameter rather than the whole layout's key set, and that is
 * the point: the four portraits are ~200 KB each and only two fighters are on
 * screen in a Match. Fetching the pair actually in play keeps three quarters of
 * a megabyte off a page whose whole first-frame budget is two seconds -- and
 * when character select lands it passes a different pair here and nothing else
 * changes.
 */
export function imageUrlsFor(
  layout: UltSheetLayout,
  roster: readonly RosterId[],
): readonly string[] {
  const urls: string[] = [];
  for (const id of roster) {
    const entry = layout.fighters[id];
    if (entry === undefined) {
      continue;
    }
    urls.push(entry.portrait);
    for (const part of ULT_PARTS) {
      urls.push(entry.parts[part].image);
    }
  }
  return Object.freeze([...new Set(urls)]);
}

/**
 * Binds a validated layout to whichever of its images actually decoded.
 *
 * Bounds are checked here, once, at creation -- so a cell that overruns its
 * image is dropped before it can reach the paint path, where `drawImage` with
 * an out-of-bounds source rect draws nothing and reports nothing.
 *
 * A fighter is bound only if **all three** parts resolve; the portrait is bound
 * independently. Partially binding the parts would mean a beam with no muzzle,
 * which reads as a rendering fault rather than as missing art, while a missing
 * portrait has a designed stand-in (Story 10.4's banner).
 */
export function createUltSheet(
  images: ReadonlyMap<string, SpriteImage>,
  layout: UltSheetLayout,
): UltSheet {
  // A snapshot, not the caller's map, for `createVfxSheet`'s reason: a
  // `ReadonlyMap` is a compile-time view of a runtime-mutable object, and the
  // bounds below run exactly once.
  const owned = new Map(images);

  const cellIn = (image: SpriteImage, cell: UltCell): boolean =>
    cell.x + layout.cellWidth <= image.width && cell.y + layout.cellHeight <= image.height;

  const parts = new Map<string, UltFrame>();
  const portraits = new Map<RosterId, UltFrame>();
  const bound: RosterId[] = [];
  const urls: string[] = [];

  for (const id of ROSTER_IDS) {
    const entry = layout.fighters[id];
    if (entry === undefined) {
      continue;
    }

    const portraitImage = owned.get(entry.portrait);
    if (portraitImage !== undefined) {
      portraits.set(
        id,
        Object.freeze({
          image: portraitImage,
          sx: 0,
          sy: 0,
          sw: portraitImage.width,
          sh: portraitImage.height,
        }),
      );
      urls.push(entry.portrait);
    }

    const resolved: [UltPart, UltFrame][] = [];
    for (const part of ULT_PARTS) {
      const cell = entry.parts[part];
      const image = owned.get(cell.image);
      if (image === undefined || !cellIn(image, cell)) {
        continue;
      }
      resolved.push([
        part,
        Object.freeze({
          image,
          sx: cell.x,
          sy: cell.y,
          sw: layout.cellWidth,
          sh: layout.cellHeight,
        }),
      ]);
    }

    if (resolved.length !== ULT_PARTS.length) {
      continue;
    }
    for (const [part, frame] of resolved) {
      parts.set(`${id}/${part}`, frame);
      urls.push(entry.parts[part].image);
    }
    bound.push(id);
  }

  return Object.freeze({
    fighters: Object.freeze(bound),
    imageUrls: Object.freeze([...new Set(urls)]),
    partFor: (id: RosterId, part: UltPart): UltFrame | undefined => parts.get(`${id}/${part}`),
    portraitFor: (id: RosterId): UltFrame | undefined => portraits.get(id),
  });
}
