import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

/**
 * Pinned against the published FIPS 180-4 / NIST vectors rather than against
 * `node:crypto`: importing the Node built-in even here would put it in this
 * package's test graph and blur the AD-4 boundary the whole package exists to
 * hold. Published digests are a stronger oracle anyway -- they are
 * independent of whatever runtime happens to execute the suite.
 */
describe('sha256Hex (browser-safe, AD-4)', () => {
  it('matches the published digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the published digest of "abc" (one-block padding)', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the published digest of the 56-byte two-block vector', () => {
    // 56 bytes: the length field no longer fits in the first block, so this
    // is the case that catches an off-by-one in the padding-block count.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches the published digest of the 112-byte three-block vector', () => {
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('matches the published digest of one million "a" characters', () => {
    // The only vector here that exercises a bit length above 2**20, i.e. the
    // high word of the 64-bit length field being anything but a rounding of
    // the low one.
    expect(sha256Hex('a'.repeat(1000000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('pads correctly at every block boundary', () => {
    // The padding-block count is `floor((len + 8) / 64) + 1`. Lengths 55/56
    // and 119/120 are where that expression changes value: at 56 the 8-byte
    // length field no longer fits alongside the 0x80 terminator in the first
    // block, so an off-by-one produces a digest that is wrong for exactly
    // these inputs and right for every other vector in this file.
    const expected: readonly (readonly [number, string])[] = [
      [54, 'a3f01b6939256127582ac8ae9fb47a382a244680806a3f613a118851c1ca1d47'],
      [55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
      [56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
      [57, 'f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6'],
      [63, '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34'],
      [64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
      [65, '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0'],
      [111, '6374f73208854473827f6f6a3f43b1f53eaa3b82c21c1a6d69a2110b2a79baad'],
      [112, 'f54353008a2553262ecdc4a34749563ba0950e8b0fc8652780b0a614b99683c1'],
      [119, '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb'],
      [120, '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c'],
      [128, '6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e'],
    ];
    for (const [length, digest] of expected) {
      expect(sha256Hex('a'.repeat(length))).toBe(digest);
    }
  });

  it('always returns 64 lowercase hex characters', () => {
    for (const input of ['', 'a', 'the quick brown fox', '{"tick":30}']) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('encodes non-ASCII input as UTF-8', () => {
    // Published digests for two- and three-byte UTF-8 sequences. A UTF-16 or
    // Latin-1 encoding path would disagree here while still passing every
    // ASCII vector above.
    expect(sha256Hex('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
    expect(sha256Hex('日本')).toBe(
      'cf2abf0c5be326cb922a70f8163f91079c4d9aa8655c60ead89ad545c9de2e92',
    );
  });

  it('replaces a lone surrogate rather than emitting invalid UTF-8', () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const replacement = '�';

    expect(sha256Hex(loneHigh)).toBe(sha256Hex(replacement));
    expect(sha256Hex(loneLow)).toBe(sha256Hex(replacement));
  });

  it('encodes a surrogate pair as a single supplementary code point', () => {
    const pair = String.fromCharCode(0xd83d, 0xde00);
    expect(sha256Hex(pair)).not.toBe(sha256Hex('��'));
    expect(sha256Hex(pair)).toHaveLength(64);
  });

  it('is deterministic across repeated calls', () => {
    const digests = new Set([sha256Hex('tokenbrawl'), sha256Hex('tokenbrawl'), sha256Hex('tokenbrawl')]);
    expect(digests.size).toBe(1);
  });
});
