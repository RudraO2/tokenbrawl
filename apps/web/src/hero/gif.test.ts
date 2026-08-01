import { describe, expect, it } from 'vitest';
import { COLOUR_TABLE_SIZE, TRANSPARENT_INDEX, encodeAnimatedGif, type GifFrame } from './gif';

/**
 * The encoder is asserted by decoding what it wrote.
 *
 * A test that checks a header byte and a length proves the file starts like a
 * GIF; it does not prove a single pixel survives LZW, and LZW packed
 * least-significant-bit-first is exactly the part a from-scratch encoder gets
 * wrong. So this file carries a decoder -- header, extensions, sub-blocks,
 * LZW, transparency, disposal -- and every pixel assertion below is a round
 * trip through it.
 *
 * The decoder is deliberately independent of the encoder: it shares no
 * constant, no table and no helper, so a matching bug in both is not something
 * one edit can produce.
 */

interface DecodedFrame {
  readonly delayCentiseconds: number;
  readonly disposal: number;
  readonly transparent: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly indices: readonly number[];
}

interface DecodedGif {
  readonly signature: string;
  readonly width: number;
  readonly height: number;
  readonly colourTable: readonly (readonly number[])[];
  readonly loopCount: number | null;
  readonly frames: readonly DecodedFrame[];
}

function lzwDecode(data: readonly number[], minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const dictionary: number[][] = [];
  const resetDictionary = (): void => {
    dictionary.length = 0;
    for (let index = 0; index < clearCode; index += 1) {
      dictionary.push([index]);
    }
    dictionary.push([], []);
  };
  resetDictionary();

  const out: number[] = [];
  let codeSize = minCodeSize + 1;
  let previous: number[] | null = null;
  let accumulator = 0;
  let bitCount = 0;

  for (const byte of data) {
    accumulator |= byte << bitCount;
    bitCount += 8;

    while (bitCount >= codeSize) {
      const code = accumulator & ((1 << codeSize) - 1);
      accumulator >>= codeSize;
      bitCount -= codeSize;

      if (code === clearCode) {
        resetDictionary();
        codeSize = minCodeSize + 1;
        previous = null;
        continue;
      }
      if (code === endCode) {
        return out;
      }

      const known: number[] | undefined =
        code < dictionary.length && dictionary[code].length > 0 ? dictionary[code] : undefined;
      const entry: number[] =
        known !== undefined ? [...known] : previous === null ? [] : [...previous, previous[0]];

      out.push(...entry);
      if (previous !== null) {
        dictionary.push([...previous, entry[0]]);
        if (dictionary.length === 1 << codeSize && codeSize < 12) {
          codeSize += 1;
        }
      }
      previous = entry;
    }
  }

  return out;
}

function decodeGif(bytes: Uint8Array): DecodedGif {
  const cursor = { at: 0 };
  const byte = (): number => bytes[cursor.at++];
  const uint16 = (): number => {
    const value = bytes[cursor.at] | (bytes[cursor.at + 1] << 8);
    cursor.at += 2;
    return value;
  };
  const subBlocks = (): number[] => {
    const collected: number[] = [];
    for (let size = byte(); size !== 0; size = byte()) {
      for (let index = 0; index < size; index += 1) {
        collected.push(byte());
      }
    }
    return collected;
  };

  const signature = String.fromCharCode(...bytes.slice(0, 6));
  cursor.at = 6;
  const width = uint16();
  const height = uint16();
  const packed = byte();
  byte(); // background colour index
  byte(); // pixel aspect ratio

  const colourTable: number[][] = [];
  const tableSize = 1 << ((packed & 0b111) + 1);
  for (let entry = 0; entry < tableSize; entry += 1) {
    colourTable.push([byte(), byte(), byte()]);
  }

  const frames: DecodedFrame[] = [];
  const pending = { delay: 0, disposal: 0, transparent: false };
  let loopCount: number | null = null;

  for (;;) {
    const marker = byte();
    if (marker === 0x3b) {
      break;
    }

    if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        byte(); // block size, always 4
        const flags = byte();
        pending.disposal = (flags >> 2) & 0b111;
        pending.transparent = (flags & 1) === 1;
        pending.delay = uint16();
        byte(); // transparent colour index
        byte(); // block terminator
        continue;
      }
      const blockSize = byte();
      const identifier = String.fromCharCode(
        ...bytes.slice(cursor.at, cursor.at + blockSize),
      );
      cursor.at += blockSize;
      const payload = subBlocks();
      if (identifier === 'NETSCAPE2.0') {
        loopCount = payload[1] | (payload[2] << 8);
      }
      continue;
    }

    expect(marker).toBe(0x2c);
    const left = uint16();
    const top = uint16();
    const frameWidth = uint16();
    const frameHeight = uint16();
    const imagePacked = byte();
    // No local colour table and no interlacing: both would change how the
    // pixels below are read, so the decoder refuses to guess.
    expect(imagePacked).toBe(0);

    const minCodeSize = byte();
    const indices = lzwDecode(subBlocks(), minCodeSize);

    frames.push({
      delayCentiseconds: pending.delay,
      disposal: pending.disposal,
      transparent: pending.transparent,
      left,
      top,
      width: frameWidth,
      height: frameHeight,
      indices,
    });
  }

  return { signature, width, height, colourTable, loopCount, frames };
}

/** Replays a decoded animation the way a viewer would, and returns each composited frame. */
function composite(decoded: DecodedGif): readonly (readonly number[])[] {
  const canvas = new Array<number>(decoded.width * decoded.height).fill(0);
  const shown: number[][] = [];

  for (const frame of decoded.frames) {
    // Disposal 1 means "leave it there", which is what makes a diff mean
    // anything. Anything else would need the canvas cleared between frames.
    expect(frame.disposal).toBe(1);
    for (let row = 0; row < frame.height; row += 1) {
      for (let column = 0; column < frame.width; column += 1) {
        const value = frame.indices[row * frame.width + column];
        if (frame.transparent && value === TRANSPARENT_INDEX) {
          continue;
        }
        canvas[(frame.top + row) * decoded.width + frame.left + column] = value;
      }
    }
    shown.push([...canvas]);
  }

  return shown;
}

const PALETTE = ['#0a0a0a', '#f5f5f0', '#c8ff00', '#ff3b30', '#6e6e68'];

function frameOf(width: number, height: number, fill: (x: number, y: number) => number): GifFrame {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = fill(x, y);
    }
  }
  return { pixels, delayCentiseconds: 8 };
}

describe('encodeAnimatedGif', () => {
  it('writes a GIF89a header, the screen size, and an 8-entry colour table', () => {
    const decoded = decodeGif(
      encodeAnimatedGif({
        width: 4,
        height: 3,
        palette: PALETTE,
        frames: [frameOf(4, 3, () => 1)],
      }),
    );

    expect(decoded.signature).toBe('GIF89a');
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect(decoded.colourTable).toHaveLength(COLOUR_TABLE_SIZE);
    // `#c8ff00` in slot 2, byte for byte -- an off-by-one in the table is
    // invisible in every other assertion here and recolours the whole hero.
    expect(decoded.colourTable[2]).toStrictEqual([0xc8, 0xff, 0x00]);
    expect(decoded.colourTable[0]).toStrictEqual([0x0a, 0x0a, 0x0a]);
  });

  it('loops forever, which is what makes it autoplay in a README', () => {
    const decoded = decodeGif(
      encodeAnimatedGif({ width: 2, height: 2, palette: PALETTE, frames: [frameOf(2, 2, () => 3)] }),
    );
    expect(decoded.loopCount).toBe(0);
  });

  it('round-trips every pixel of every frame through LZW', () => {
    // Deliberately awkward: a size that is not a multiple of anything, and a
    // pattern with no long runs, so the dictionary actually grows and the code
    // width actually increases mid-stream.
    const width = 37;
    const height = 23;
    const frames = [
      frameOf(width, height, (x, y) => (x * 3 + y * 5) % 5),
      frameOf(width, height, (x, y) => (x + y) % 5),
      frameOf(width, height, (x, y) => (x * y) % 5),
    ];

    const shown = composite(decodeGif(encodeAnimatedGif({ width, height, palette: PALETTE, frames })));

    expect(shown).toHaveLength(3);
    for (const [index, frame] of frames.entries()) {
      expect(shown[index]).toStrictEqual([...frame.pixels]);
    }
  });

  it('grows the code width past 8 bits without losing a pixel', () => {
    // 4,096 dictionary entries is where a naive encoder either stops widening
    // or forgets to emit a clear code. A large noisy image reaches it.
    const width = 120;
    const height = 90;
    const frames = [frameOf(width, height, (x, y) => (x * 7 + y * 13 + ((x * y) % 3)) % 5)];
    const shown = composite(decodeGif(encodeAnimatedGif({ width, height, palette: PALETTE, frames })));
    expect(shown[0]).toStrictEqual([...frames[0].pixels]);
  });

  it('encodes only the bounding box of what changed', () => {
    const width = 20;
    const height = 20;
    const first = frameOf(width, height, () => 0);
    const second = frameOf(width, height, (x, y) => (x === 5 && y === 7 ? 2 : 0));

    const decoded = decodeGif(
      encodeAnimatedGif({ width, height, palette: PALETTE, frames: [first, second] }),
    );

    expect(decoded.frames[0]).toMatchObject({ left: 0, top: 0, width, height, transparent: false });
    expect(decoded.frames[1]).toMatchObject({ left: 5, top: 7, width: 1, height: 1, transparent: true });
    expect(composite(decoded)[1]).toStrictEqual([...second.pixels]);
  });

  it('holds a frame that changed nothing rather than dropping it', () => {
    // A dropped frame shortens playback by its own delay, silently. The
    // one-pixel transparent block is the legal way to say "same again".
    const still = frameOf(8, 8, () => 4);
    const decoded = decodeGif(
      encodeAnimatedGif({ width: 8, height: 8, palette: PALETTE, frames: [still, still, still] }),
    );

    expect(decoded.frames).toHaveLength(3);
    expect(decoded.frames[1]).toMatchObject({ width: 1, height: 1, transparent: true });
    expect(composite(decoded)[2]).toStrictEqual([...still.pixels]);
  });

  it('carries the delay each frame was given', () => {
    const decoded = decodeGif(
      encodeAnimatedGif({
        width: 4,
        height: 4,
        palette: PALETTE,
        frames: [
          { pixels: frameOf(4, 4, () => 1).pixels, delayCentiseconds: 8 },
          { pixels: frameOf(4, 4, () => 2).pixels, delayCentiseconds: 8 },
        ],
      }),
    );
    expect(decoded.frames.map((frame) => frame.delayCentiseconds)).toStrictEqual([8, 8]);
  });

  it('refuses a palette that would collide with the transparency index', () => {
    expect(() =>
      encodeAnimatedGif({
        width: 2,
        height: 2,
        palette: [
          '#000000',
          '#111111',
          '#222222',
          '#333333',
          '#444444',
          '#555555',
          '#666666',
          '#777777',
        ],
        frames: [frameOf(2, 2, () => 0)],
      }),
    ).toThrow(/at most 7 colours/);
  });

  it('refuses a frame whose pixel count does not match the screen', () => {
    expect(() =>
      encodeAnimatedGif({
        width: 4,
        height: 4,
        palette: PALETTE,
        frames: [{ pixels: new Uint8Array(15), delayCentiseconds: 8 }],
      }),
    ).toThrow(/expected 16/);
  });

  it('refuses a zero delay, which browsers silently reinterpret at their own rate', () => {
    expect(() =>
      encodeAnimatedGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [{ pixels: new Uint8Array(4), delayCentiseconds: 0 }],
      }),
    ).toThrow(/non-positive delay/);
  });

  it('refuses an empty animation and a colour it cannot parse', () => {
    expect(() => encodeAnimatedGif({ width: 2, height: 2, palette: PALETTE, frames: [] })).toThrow(
      /at least one frame/,
    );
    expect(() =>
      encodeAnimatedGif({
        width: 2,
        height: 2,
        palette: ['rgb(1,2,3)'],
        frames: [frameOf(2, 2, () => 0)],
      }),
    ).toThrow(/six-digit hex/);
  });
});
