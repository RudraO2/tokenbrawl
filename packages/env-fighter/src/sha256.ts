/**
 * SHA-256 in plain TypeScript.
 *
 * `packages/core` already has a `sha256Hex`, but it is `node:crypto`-bound.
 * AD-4 requires this package to run unmodified in Node *and* in a browser tab
 * (the replay player re-runs this very engine), so the primitive is
 * reimplemented here rather than imported. Correctness is pinned by the
 * published FIPS 180-4 test vectors in `sha256.test.ts`, not by agreement with
 * `node:crypto` -- importing it even in a test would put a Node built-in in
 * this package's graph.
 *
 * Every operation is 32-bit integer arithmetic: no floating point enters the
 * simulation's hash path (INV-2).
 */

/** FIPS 180-4 round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Initial hash values: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_HASH: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const BYTES_PER_BLOCK = 64;
const BYTES_PER_LENGTH_FIELD = 8;
const BITS_PER_BYTE = 8;
/** 2 to the 32nd, written as a literal: float-producing exponentiation helpers are banned here (INV-2). */
const TWO_POW_32 = 4294967296;

const REPLACEMENT_CODE_POINT = 0xfffd;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const SUPPLEMENTARY_PLANE_START = 0x10000;

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) | 0;
}

/**
 * UTF-8 encode without `TextEncoder`: the `ES2022` lib this repo compiles
 * against declares no such global, and pulling in DOM or `@types/node`
 * globals to get one would undo the point of a dependency-free package.
 *
 * A lone surrogate becomes U+FFFD, matching WHATWG encoding, so a malformed
 * string still hashes to *something* stable rather than producing bytes no
 * other SHA-256 implementation would agree with.
 */
function utf8Bytes(input: string): Uint8Array {
  const out: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);

    if (codePoint >= HIGH_SURROGATE_START && codePoint <= HIGH_SURROGATE_END) {
      const low = index + 1 < input.length ? input.charCodeAt(index + 1) : -1;
      if (low >= LOW_SURROGATE_START && low <= LOW_SURROGATE_END) {
        codePoint =
          SUPPLEMENTARY_PLANE_START +
          ((codePoint - HIGH_SURROGATE_START) << 10) +
          (low - LOW_SURROGATE_START);
        index += 1;
      } else {
        codePoint = REPLACEMENT_CODE_POINT;
      }
    } else if (codePoint >= LOW_SURROGATE_START && codePoint <= LOW_SURROGATE_END) {
      codePoint = REPLACEMENT_CODE_POINT;
    }

    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < SUPPLEMENTARY_PLANE_START) {
      out.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return Uint8Array.from(out);
}

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);

  // One 0x80 byte, then zeroes, then a 64-bit big-endian bit length, padded
  // out to a whole number of 64-byte blocks.
  const blockCount = Math.floor((bytes.length + BYTES_PER_LENGTH_FIELD) / BYTES_PER_BLOCK) + 1;
  const padded = new Uint8Array(blockCount * BYTES_PER_BLOCK);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = bytes.length * BITS_PER_BYTE;
  const bitLengthHigh = Math.floor(bitLength / TWO_POW_32);
  const bitLengthLow = bitLength - bitLengthHigh * TWO_POW_32;
  const lengthOffset = padded.length - BYTES_PER_LENGTH_FIELD;
  padded[lengthOffset] = (bitLengthHigh >>> 24) & 0xff;
  padded[lengthOffset + 1] = (bitLengthHigh >>> 16) & 0xff;
  padded[lengthOffset + 2] = (bitLengthHigh >>> 8) & 0xff;
  padded[lengthOffset + 3] = bitLengthHigh & 0xff;
  padded[lengthOffset + 4] = (bitLengthLow >>> 24) & 0xff;
  padded[lengthOffset + 5] = (bitLengthLow >>> 16) & 0xff;
  padded[lengthOffset + 6] = (bitLengthLow >>> 8) & 0xff;
  padded[lengthOffset + 7] = bitLengthLow & 0xff;

  const hash = Int32Array.from(INITIAL_HASH);
  const schedule = new Int32Array(64);

  for (let block = 0; block < blockCount; block += 1) {
    const base = block * BYTES_PER_BLOCK;

    for (let t = 0; t < 16; t += 1) {
      const offset = base + t * 4;
      schedule[t] =
        (padded[offset] << 24) |
        (padded[offset + 1] << 16) |
        (padded[offset + 2] << 8) |
        padded[offset + 3];
    }
    for (let t = 16; t < 64; t += 1) {
      const previous = schedule[t - 15];
      const recent = schedule[t - 2];
      const s0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const s1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      schedule[t] = (schedule[t - 16] + s0 + schedule[t - 7] + s1) | 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let t = 0; t < 64; t += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + ROUND_CONSTANTS[t] + schedule[t]) | 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  let digest = '';
  for (let index = 0; index < hash.length; index += 1) {
    digest += toHex32(hash[index]);
  }
  return digest;
}
