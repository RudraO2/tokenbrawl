import { describe, expect, it } from 'vitest';
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphRows, hasGlyph, measureText } from './font';
import { STAND_IN_NOTICE } from './hero';

/**
 * The font is data, and data with a typo in it reaches the top of the README.
 * These tests are what a proof-read would be if a proof-read could be run in CI.
 */

/** Every character the hero and the player's own HUD can put on screen. */
const REQUIRED = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...' .,:;\'"-_/()[]?!+=*%#@&<>',
];

describe('the 5x7 pixel font', () => {
  it('carries a glyph for every character the hero can draw', () => {
    expect(REQUIRED.filter((character) => !hasGlyph(character))).toStrictEqual([]);
  });

  it('carries a glyph for every character in the strings this app hard-codes', () => {
    // The renderer's own readouts plus the hero's notice. A missing glyph here
    // is a solid black box in the committed artefact.
    const drawn = `HP MTR TICK BANK REFLEX P1 P2 ${STAND_IN_NOTICE} STILL COMMITTED:`;
    expect([...drawn].filter((character) => !hasGlyph(character))).toStrictEqual([]);
  });

  it('returns seven rows of five columns, with bit 4 leftmost', () => {
    const rows = glyphRows('L');
    expect(rows).toHaveLength(GLYPH_HEIGHT);
    for (const row of rows) {
      expect(row).toBeLessThan(1 << GLYPH_WIDTH);
      expect(row).toBeGreaterThanOrEqual(0);
    }
    // An `L` is a full left column and a full bottom row: the one letter whose
    // orientation is unambiguous, so a transposed or mirrored table fails here.
    expect(rows.slice(0, 6)).toStrictEqual([16, 16, 16, 16, 16, 16]);
    expect(rows[6]).toBe(31);
  });

  it('folds case rather than failing on it', () => {
    expect(glyphRows('a')).toStrictEqual(glyphRows('A'));
  });

  it('draws a character it has no glyph for as a filled box, never as nothing', () => {
    // Blank would hide the defect in a 96-frame animation nobody steps through.
    const rows = glyphRows('é');
    expect(hasGlyph('é')).toBe(false);
    expect(rows).toStrictEqual([31, 31, 31, 31, 31, 31, 31]);
  });

  it('leaves a space genuinely blank', () => {
    expect(glyphRows(' ')).toStrictEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('measures a string as glyphs plus the gaps between them, with no trailing gap', () => {
    expect(measureText('', 2)).toBe(0);
    expect(measureText('A', 2)).toBe(GLYPH_WIDTH * 2);
    expect(measureText('AB', 2)).toBe(GLYPH_WIDTH * 2 * 2 + 2);
    expect(measureText('ABC', 3)).toBe(GLYPH_WIDTH * 3 * 3 + 3 * 2);
  });

  it('draws no two letters the same', () => {
    // A copy-paste in the table is the most likely defect in a hand-authored
    // font and the least likely to be noticed: `O` pasted over `Q` still reads
    // as a letter.
    const seen = new Map<string, string>();
    for (const character of REQUIRED) {
      if (character === ' ') {
        continue;
      }
      const key = glyphRows(character).join(',');
      expect(seen.get(key)).toBeUndefined();
      seen.set(key, character);
    }
  });
});
