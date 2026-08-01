/**
 * Story 7.4: a GIF89a encoder, in-repo and dependency-free.
 *
 * AC1 asks for an animation that plays on GitHub **without a click**, which
 * narrows the format to one: GitHub renders an animated GIF inline in a README
 * and nothing else. A video needs a click, an SVG animation is stripped by the
 * content sanitiser, and an APNG is not animated by every client.
 *
 * INV-8 and `apps/web`'s two-devDependency budget rule out a library, so the
 * format is implemented here. It is a small format: a header, a colour table,
 * a loop extension nobody documents properly, and LZW.
 *
 * ## Inter-frame diffing
 *
 * At 960x560 a full frame is 537,600 pixels. Eighty of those, encoded whole,
 * is four times the file for the same animation. So every frame after the first is
 * encoded as the bounding box of what changed, with unchanged pixels written as
 * a transparent index and disposal method 1 ("leave it there"). The arena
 * ground, the borders and the static HUD furniture are paid for once.
 *
 * A frame identical to its predecessor still emits a 1x1 transparent block: a
 * zero-size image descriptor is not legal GIF, and dropping the frame would
 * silently shorten playback by its delay.
 */

/** The palette slot reserved for "unchanged since the previous frame". */
export const TRANSPARENT_INDEX = 7;
/** Entries in the global colour table. A power of two, as the format requires. */
export const COLOUR_TABLE_SIZE = 8;
/** LZW code width floor for an 8-entry table. */
const MIN_CODE_SIZE = 3;

export interface GifFrame {
  /** One palette index per pixel, row-major, `width * height` long. */
  readonly pixels: Uint8Array;
  /** Hundredths of a second this frame is held. Constant across a hero (INV-3). */
  readonly delayCentiseconds: number;
}

export interface GifOptions {
  readonly width: number;
  readonly height: number;
  /** Up to 7 colours as `#rrggbb`. Slot 7 is reserved for transparency. */
  readonly palette: readonly string[];
  readonly frames: readonly GifFrame[];
}

interface SubImage {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  /** False only for the first frame, which is opaque and full-size. */
  readonly transparent: boolean;
}

function parseColour(colour: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (match === null) {
    throw new Error(`encodeAnimatedGif: "${colour}" is not a six-digit hex colour.`);
  }
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function pushString(out: number[], text: string): void {
  for (const character of text) {
    out.push(character.charCodeAt(0));
  }
}

function pushUint16(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

/**
 * LZW as GIF specifies it: variable code width from `MIN_CODE_SIZE + 1`, a
 * clear code, an end-of-information code, and a dictionary reset once the code
 * width would exceed 12 bits.
 *
 * Bits are packed least-significant-first, which is the one detail every
 * from-scratch implementation gets wrong the first time and which the
 * round-trip test in `gif.test.ts` exists to catch.
 */
function lzwCompress(pixels: Uint8Array): number[] {
  const clearCode = 1 << MIN_CODE_SIZE;
  const endCode = clearCode + 1;

  const out: number[] = [];
  const bits = { accumulator: 0, count: 0 };
  const dictionary = new Map<number, number>();
  const state = { next: endCode + 1, codeSize: MIN_CODE_SIZE + 1, prefix: -1 };

  const emit = (code: number): void => {
    bits.accumulator |= code << bits.count;
    bits.count += state.codeSize;
    while (bits.count >= 8) {
      out.push(bits.accumulator & 0xff);
      bits.accumulator >>= 8;
      bits.count -= 8;
    }
  };

  const reset = (): void => {
    dictionary.clear();
    state.next = endCode + 1;
    state.codeSize = MIN_CODE_SIZE + 1;
  };

  emit(clearCode);
  reset();

  for (const pixel of pixels) {
    if (state.prefix === -1) {
      state.prefix = pixel;
      continue;
    }
    // The key packs (prefix, pixel) into one integer. `prefix` never exceeds
    // 4095 and `pixel` never exceeds 255, so the pair is unambiguous.
    const key = (state.prefix << 8) | pixel;
    const known = dictionary.get(key);
    if (known !== undefined) {
      state.prefix = known;
      continue;
    }

    emit(state.prefix);
    if (state.next < 1 << 12) {
      dictionary.set(key, state.next);
      state.next += 1;
      // The width grows *after* the code that fills the old range is emitted,
      // which is why this test uses the post-increment value.
      if (state.next > 1 << state.codeSize && state.codeSize < 12) {
        state.codeSize += 1;
      }
    } else {
      emit(clearCode);
      reset();
    }
    state.prefix = pixel;
  }

  if (state.prefix !== -1) {
    emit(state.prefix);
  }
  emit(endCode);

  if (bits.count > 0) {
    out.push(bits.accumulator & 0xff);
  }
  return out;
}

/** GIF carries compressed data in sub-blocks of at most 255 bytes, terminated by an empty one. */
function pushSubBlocks(out: number[], data: readonly number[]): void {
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.slice(offset, offset + 255);
    out.push(chunk.length);
    out.push(...chunk);
  }
  out.push(0);
}

/** The whole frame, opaque. Used for the first frame and by nothing else. */
function fullImage(pixels: Uint8Array, width: number, height: number): SubImage {
  return { left: 0, top: 0, width, height, pixels: Uint8Array.from(pixels), transparent: false };
}

/** The bounding box of what changed, with everything else written as transparent. */
function diffImage(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
): SubImage {
  const bounds = { left: width, top: height, right: -1, bottom: -1 };
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * width + column;
      if (previous[offset] === current[offset]) {
        continue;
      }
      bounds.left = Math.min(bounds.left, column);
      bounds.right = Math.max(bounds.right, column);
      bounds.top = Math.min(bounds.top, row);
      bounds.bottom = Math.max(bounds.bottom, row);
    }
  }

  if (bounds.right < bounds.left || bounds.bottom < bounds.top) {
    // Nothing moved. A 1x1 transparent block holds the previous frame for
    // another delay; an image of zero width is not a legal descriptor and
    // omitting the frame would shorten the animation.
    return {
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      pixels: Uint8Array.of(TRANSPARENT_INDEX),
      transparent: true,
    };
  }

  const boxWidth = bounds.right - bounds.left + 1;
  const boxHeight = bounds.bottom - bounds.top + 1;
  const pixels = new Uint8Array(boxWidth * boxHeight);
  for (let row = 0; row < boxHeight; row += 1) {
    for (let column = 0; column < boxWidth; column += 1) {
      const source = (bounds.top + row) * width + bounds.left + column;
      pixels[row * boxWidth + column] =
        previous[source] === current[source] ? TRANSPARENT_INDEX : current[source];
    }
  }

  return {
    left: bounds.left,
    top: bounds.top,
    width: boxWidth,
    height: boxHeight,
    pixels,
    transparent: true,
  };
}

export function encodeAnimatedGif(options: GifOptions): Uint8Array {
  const { width, height, palette, frames } = options;

  if (palette.length > TRANSPARENT_INDEX) {
    throw new Error(
      `encodeAnimatedGif: the palette may hold at most ${String(TRANSPARENT_INDEX)} colours; slot ${String(TRANSPARENT_INDEX)} is the transparency index.`,
    );
  }
  if (frames.length === 0) {
    throw new Error('encodeAnimatedGif: an animation needs at least one frame.');
  }
  for (const [index, frame] of frames.entries()) {
    if (frame.pixels.length !== width * height) {
      throw new Error(
        `encodeAnimatedGif: frame ${String(index)} has ${String(frame.pixels.length)} pixels, expected ${String(width * height)}.`,
      );
    }
    if (!Number.isSafeInteger(frame.delayCentiseconds) || frame.delayCentiseconds <= 0) {
      throw new Error(
        `encodeAnimatedGif: frame ${String(index)} has a non-positive delay, which browsers reinterpret at their own default rate.`,
      );
    }
  }

  const out: number[] = [];
  pushString(out, 'GIF89a');

  pushUint16(out, width);
  pushUint16(out, height);
  // Global colour table present, 8 bits of colour resolution, 8 entries.
  out.push(0x80 | 0x70 | (MIN_CODE_SIZE - 1));
  out.push(0); // Background: palette slot 0, the ground colour.
  out.push(0); // No pixel aspect ratio.

  for (let slot = 0; slot < COLOUR_TABLE_SIZE; slot += 1) {
    const [red, green, blue] =
      slot < palette.length ? parseColour(palette[slot]) : ([0, 0, 0] as const);
    out.push(red, green, blue);
  }

  // The Netscape application extension. Loop count 0 means forever, which is
  // what "autoplaying" means for a README that nobody scrolls back to.
  out.push(0x21, 0xff, 0x0b);
  pushString(out, 'NETSCAPE2.0');
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const [index, frame] of frames.entries()) {
    const image =
      index === 0
        ? fullImage(frame.pixels, width, height)
        : diffImage(frames[index - 1].pixels, frame.pixels, width, height);

    // Graphic control extension: disposal 1 (leave the frame in place, which is
    // what makes a diff mean anything), plus the transparency flag.
    out.push(0x21, 0xf9, 0x04);
    out.push((1 << 2) | (image.transparent ? 1 : 0));
    pushUint16(out, frame.delayCentiseconds);
    out.push(TRANSPARENT_INDEX);
    out.push(0x00);

    out.push(0x2c);
    pushUint16(out, image.left);
    pushUint16(out, image.top);
    pushUint16(out, image.width);
    pushUint16(out, image.height);
    out.push(0x00); // No local colour table, not interlaced.

    out.push(MIN_CODE_SIZE);
    pushSubBlocks(out, lzwCompress(image.pixels));
  }

  out.push(0x3b);
  return Uint8Array.from(out);
}
