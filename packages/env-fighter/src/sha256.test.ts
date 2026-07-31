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
