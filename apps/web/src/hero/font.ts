/**
 * Story 7.4: a 5x7 pixel font, authored in this repo.
 *
 * The hero animation is rasterised by this project, in this project, with no
 * dependency: `apps/web` has exactly `vite` and `vitest` and INV-8 says it
 * stays that way. `THEME.monoFont` names Departure Mono, and turning a `woff2`
 * into pixels needs a font engine -- which is the dependency this file exists
 * to avoid.
 *
 * So the glyphs are written out. That is the same choice `createBlockArtist`
 * made and for the same reason: art authored here is unambiguously licence-
 * clean, and `docs/ASSETS.md` records it as authored rather than sourced. A
 * pixel grid is also the right face for the job -- the hero is an 8-bit arcade
 * frame, not a document.
 *
 * The font is uppercase-only by design. The house display style is uppercase
 * (`docs/DESIGN.md`), the player's own HUD readouts already are, and 26 fewer
 * glyphs is 26 fewer things to get subtly wrong; `glyphRows` upper-cases what
 * it is given rather than failing on it.
 */

/** Columns per glyph, before scaling. Bit 4 is the leftmost. */
export const GLYPH_WIDTH = 5;
/** Rows per glyph, before scaling. */
export const GLYPH_HEIGHT = 7;
/** Blank columns between two glyphs, before scaling. */
export const GLYPH_SPACING = 1;

/**
 * Glyphs as seven rows of five cells. `#` is ink, anything else is ground.
 *
 * Written as text rather than as bitmasks so that a reviewer can see the letter
 * -- a table of hex numbers is a table nobody proof-reads, and a font nobody
 * proof-reads is how a misdrawn `S` reaches the top of the README.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ';': ['.....', '.##..', '.##..', '.....', '.##..', '.#...', '.....'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '*': ['.....', '..#..', '#.#.#', '.###.', '#.#.#', '..#..', '.....'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.###.'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
});

/**
 * A character with no glyph draws as a filled box.
 *
 * Deliberately not blank. A missing glyph is a defect in this file, and a
 * defect that renders as whitespace is one nobody notices in a 96-frame
 * animation; a solid block is visible in the artefact and in the tests alike.
 */
const MISSING: readonly string[] = Object.freeze([
  '#####',
  '#####',
  '#####',
  '#####',
  '#####',
  '#####',
  '#####',
]);

function toRow(cells: string): number {
  let row = 0;
  for (let column = 0; column < GLYPH_WIDTH; column += 1) {
    if (cells[column] === '#') {
      row |= 1 << (GLYPH_WIDTH - 1 - column);
    }
  }
  return row;
}

/**
 * The seven scanlines of one character, as bitmasks. Bit 4 is the leftmost
 * column, so a row can be walked left to right by shifting down.
 *
 * Case-folded, because the font is uppercase-only and refusing lowercase would
 * turn a caption's stray letter into a thrown error at build time.
 */
export function glyphRows(character: string): readonly number[] {
  const cells = GLYPHS[character.toUpperCase()] ?? MISSING;
  return cells.map(toRow);
}

/** Whether this file carries a real glyph for a character. Used by the tests and by nothing else. */
export function hasGlyph(character: string): boolean {
  return GLYPHS[character.toUpperCase()] !== undefined;
}

/**
 * Rendered width of a string in pixels, including the gap between glyphs but
 * not a trailing one -- the same convention `measureText` has on a real canvas,
 * so centring arithmetic transfers unchanged.
 */
export function measureText(text: string, scale: number): number {
  if (text.length === 0) {
    return 0;
  }
  return text.length * (GLYPH_WIDTH + GLYPH_SPACING) * scale - GLYPH_SPACING * scale;
}
