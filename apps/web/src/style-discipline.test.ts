import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARENA_PALETTE } from './render/arena-palette';
import { THEME } from './render/theme';

/**
 * Story 4.1: the house style, enforced rather than asked for.
 *
 * `docs/DESIGN.md` fixes the visual language for six UI stories built in six
 * separate sessions. Written down, that lasts until the first session that
 * does not read it. Written as a test, it lasts.
 *
 * These are the rules that are actually greppable. The ones that are not --
 * asymmetric layout, chunky blocks, whether the result reads as a template --
 * belong to the Style Auditor review layer, which is where judgement lives.
 *
 * ## Story 11.1: the same rules, over two regimes rather than one
 *
 * Three of the rules below used to sweep every `.css` and `.ts` file in the
 * app alike. That was never a decision -- the canvas half arrived because
 * Story 4.1's sprite artist painted `globalAlpha = 0.55` across a whole
 * 600x600 frame, a red pane over a third of the arena, and the fastest way to
 * stop *that* was to point the stylesheet's flat-surface rule at the drawing
 * code too.
 *
 * The owner ruled on 2026-08-07 that those rules were meant for the UI and not
 * for the game inside it. So the fence is **narrowed, not removed**: page
 * chrome keeps every rule it has, and the arena -- named below, and named
 * again in `docs/DESIGN.md` -- is released from translucency, gradient and
 * partial alpha. It is *not* released from having a palette; a raw hex literal
 * at a call site inside the arena still fails.
 *
 * Each of the three scoped rules is written as a function of
 * `readonly StyledFile[]` rather than as a loop inside its `it()`. That is the
 * difference between a rule and a rule that can be tested: a loop over the
 * real tree can only ever assert that today's tree is clean, and "a planted
 * `rgba(` still fails" is then checkable solely by planting one and watching
 * CI go red, which is not a test. As predicates, both the real sweep and the
 * planted case are one line each, and the planted cases below are the actual
 * evidence that the page side did not quietly lose its rules along with the
 * arena.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const APP = join(SRC, '..');
const REPO = join(APP, '..', '..');

/**
 * The arena boundary, and the whole of Story 11.1's ruling in one string.
 *
 * Everything under `apps/web/src/render/` is **the game**; everything else in
 * this app is **the page**. It is a directory rather than a per-file
 * allowlist on purpose: `render/` is already exactly the set of files that
 * draw the fight, and an allowlist would need an entry added by 11.2, 11.3,
 * 11.4 and 11.6 -- a boundary that every story edits is not a boundary.
 *
 * The one non-obvious call is `hero/`, which also touches a canvas. It stays
 * on the **page** side, because what it produces is a page asset -- the
 * landing hero raster -- not a surface a Match is played on. `docs/DESIGN.md`
 * records that call in prose so it does not live only here.
 */
const ARENA_BOUNDARY = 'render/';

/**
 * Every spelling of a TypeScript module, and the reason it is a pattern rather
 * than `.endsWith('.ts')`.
 *
 * `isArena` and `walk` must agree exactly. A `render/hud.tsx` under an
 * `.endsWith('.ts')` boundary and a `['.css', '.ts']` walk would be classified
 * as *not* arena and swept by nothing at all -- neither the membership ratchet
 * nor the wall-clock sweep would see it. There is no `.tsx`, `.mts` or `.cts`
 * in this app today; the point is that adding one cannot silently create a
 * file outside every rule.
 */
const TS_FILE = /\.(m|c)?tsx?$/;

/**
 * True for a file inside the arena boundary. Paths are `styledFiles()`-relative,
 * forward-slashed.
 *
 * A TypeScript file, and only a TypeScript file. The boundary released the
 * arena because a canvas draws with light, and a stylesheet cannot draw on a
 * canvas: a `render/hud.css` would be page chrome wearing the arena's
 * directory name, and releasing it from `rgba(` and `linear-gradient` would be
 * the boundary leaking rather than the boundary working. There is no `.css`
 * under `render/` today; this is the guard that keeps it from arriving
 * unnoticed.
 */
function isArena(path: string): boolean {
  return path.startsWith(ARENA_BOUNDARY) && TS_FILE.test(path);
}

/**
 * `render/theme.ts` is the one arena file that is not released.
 *
 * It lives under `render/` because the canvas is what reads it, but its whole
 * job is holding the five flat *brand* colours as a mirror of `tokens.css` --
 * `docs/DESIGN.md` puts brand squarely on the page side. Releasing the file
 * that defines page flatness from the flatness rules is the boundary leaking
 * in the same way a `render/hud.css` would: a `linear-gradient` added there
 * would pass every assertion below, in the one file whose contents are page
 * chrome by definition.
 *
 * It stays inside `isArena` for *membership* -- the exact-list ratchet and the
 * wall-clock sweep must still cover it. Only the two rules the ruling released
 * consult this narrower predicate.
 */
const BRAND_MIRROR = 'render/theme.ts';

/** Inside the arena boundary *and* released from translucency and alpha. */
function isReleased(path: string): boolean {
  return isArena(path) && path !== BRAND_MIRROR;
}

/**
 * The three files allowed to contain a colour literal, and nothing else.
 *
 * `tokens.css` and `theme.ts` are the brand, unchanged since Story 4.1.
 * `render/arena-palette.ts` joins them in Story 11.1 because the arena's
 * colours -- health tiers, super meter, per-fighter aura -- are not brand
 * tokens and would be wrong forced through `--tb-accent`. Releasing the arena
 * from the *brand* palette must not release it from having a palette, so the
 * rule keeps its shape and gains a third source rather than an exemption.
 */
const COLOUR_SOURCES = ['styles/tokens.css', 'render/theme.ts', 'render/arena-palette.ts'];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

interface StyledFile {
  readonly path: string;
  readonly source: string;
}

function walk(directory: string, extensions: readonly string[], collected: StyledFile[]): StyledFile[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, collected);
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension)) && !/\.test\.(m|c)?tsx?$/.test(entry.name)) {
      collected.push({
        path: relative(SRC, full).replace(/\\/g, '/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  }
  return collected;
}

function styledFiles(): readonly StyledFile[] {
  // Every extension `TS_FILE` recognises, plus stylesheets. A file this walk
  // does not collect is a file no rule in this suite applies to, so the two
  // lists have to be kept in step -- `the walk and the boundary agree on what
  // a TypeScript file is` below is the assertion that they are.
  return walk(SRC, ['.css', '.ts', '.tsx', '.mts', '.cts'], []);
}

/** Every non-test `.ts` file inside the arena boundary. */
function arenaFiles(): readonly StyledFile[] {
  return styledFiles().filter(({ path }) => isArena(path));
}

function tokensCss(): string {
  return readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8');
}

function designDoc(): string {
  return readFileSync(join(REPO, 'docs', 'DESIGN.md'), 'utf8');
}

/** Read as text rather than imported: this file asserts things *about* that file's source. */
function sourceDisciplineSource(): string {
  return readFileSync(join(SRC, 'source-discipline.test.ts'), 'utf8');
}

/** The one place in that file where a `render/` path legitimately appears. */
const COVERAGE_LIST_OPENER = 'expect.arrayContaining([';

/**
 * `source-discipline.test.ts` with its coverage list cut out.
 *
 * That file names `render/renderer.ts`, `render/juice.ts` and three more inside
 * an `expect.arrayContaining([...])` -- deliberately, to assert the sweep
 * *covers* them. Every other `render/` string in that file would be a path
 * parked in an exemption, which is the thing Story 11.1 must not do and must be
 * seen not to do.
 *
 * Cutting the block and then banning the string everywhere else is why this is
 * done as text rather than by parsing the call: `offendingLines(pattern,
 * exempt)` takes any list, so an inline array, a second named constant or a
 * formatter-wrapped argument are each a way an exemption arrives that a
 * `offendingLines\(...,\s*IDENT\)` regex cannot see at all. A ban on the string
 * does not care how the list was spelled.
 *
 * The array holds string literals only, so counting `[` and `]` is enough to
 * find its end -- no parenthesis or regex-literal parsing is involved.
 */
function outsideCoverageList(source: string): string {
  const start = source.indexOf(COVERAGE_LIST_OPENER);
  if (start === -1) {
    return source;
  }
  let depth = 0;
  for (let index = start + COVERAGE_LIST_OPENER.length - 1; index < source.length; index += 1) {
    if (source[index] === '[') {
      depth += 1;
    } else if (source[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(0, start) + source.slice(index + 1);
      }
    }
  }
  return source.slice(0, start);
}

/**
 * Colour is declared, never typed at a call site. Applies on both sides of the
 * boundary -- the arena got a second palette in Story 11.1, not permission to
 * scatter literals.
 */
function hexOffences(files: readonly StyledFile[]): readonly string[] {
  const offences: string[] = [];
  for (const { path, source } of files) {
    if (COLOUR_SOURCES.includes(path)) {
      continue;
    }
    for (const match of source.match(HEX) ?? []) {
      offences.push(`${path}: ${match}`);
    }
  }
  return offences;
}

/**
 * Flat fills, page side only.
 *
 * Every pattern here is a CSS-shaped one, which is why this rule reached the
 * canvas at all: `radial-gradient` in a `.ts` file is a string handed to
 * `createLinearGradient`'s CSS cousin or written into a style attribute, and
 * before Story 11.1 both were banned everywhere. Inside the arena a glow *is*
 * a gradient and impact *is* light, so the arena is skipped.
 *
 * Comments are stripped first, for the same reason `alphaOffences` strips
 * them: this rule now has to be *explained* in the files it governs -- Story
 * 11.1 wrote "translucency is banned outside the arena" into page-side source
 * as prose, and a rule that reports its own documentation is a rule the next
 * writer works around instead of obeying. `stripComments` blanks a CSS
 * `/* ... *\/` too, which is the same decision: a commented-out `rgba(` paints
 * nothing.
 */
function translucencyOffences(files: readonly StyledFile[]): readonly string[] {
  const banned = /\b(rgba\(|backdrop-filter|filter:\s*blur|linear-gradient|radial-gradient|box-shadow:[^;]*inset)/;
  return files
    .filter(({ path, source }) => !isReleased(path) && banned.test(stripComments(source)))
    .map(({ path }) => path);
}

/**
 * Comments out, line numbering intact.
 *
 * Every sweep in this file reads code rather than prose, and a prefix test on
 * the trimmed line is not enough for that: `draw(); // was globalAlpha = 0.4`
 * is a sentence about a rule, and reporting it as a violation of the rule is
 * how a rule stops being fixable. Block comments are blanked rather than
 * deleted so a reported `path:line` still points at the right line.
 *
 * Be honest about the limit: this is a text pass, not a lexer. A `//` inside a
 * string literal blanks the rest of that line, and a `/*` inside a string
 * blanks through the next `*\/`, so a rule reading its output can be made to
 * miss code by putting comment punctuation inside a string on the same line.
 * Both need a tokeniser to fix properly and neither has ever occurred in this
 * app; the failure is recorded in the deferred-work ledger rather than left as
 * an unstated assumption.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `1`, `1.0`, `1 as const`, `1 as number`, `1 satisfies number` -- opaque, however it was spelled. */
function isOpaque(value: string): boolean {
  return Number(value.replace(/\s+(as|satisfies)\s+[A-Za-z][\w.<>|\s]*$/, '')) === 1;
}

/** A port's declared shape (`globalAlpha: number`), not a draw. */
function isTypeShape(value: string): boolean {
  return /^(readonly\s+)?number(\s*\|\s*(number|undefined|null))*$/.test(value);
}

/**
 * `globalAlpha: number = 1` is an annotation *and* a value.
 *
 * A class field or a defaulted parameter writes both on one line, and the
 * whole point of this rule is that the value is what gets compared. Strip a
 * leading `number`-shaped annotation so the initialiser is what reaches
 * `isOpaque` -- `number = 1` is opaque, `number = 0.5` is still a draw and is
 * still reported.
 */
function initialiser(value: string): string {
  const annotated = /^(readonly\s+)?number(\s*\|\s*(number|undefined|null))*\s*=\s*(.+)$/.exec(value);
  return annotated === null ? value : annotated[4].trim();
}

/**
 * `render/backdrop.ts`, the named exemption from Story 4.1.
 *
 * The arena boundary makes this redundant -- `backdrop.ts` is under `render/`
 * and would be skipped anyway. It is kept deliberately, and it is checked
 * first in `alphaOffences` so it is a live arm rather than one the boundary
 * shadows. What it preserves is the *reason* one specific file was allowed to
 * dim the scenery (it composites once to a flat opaque image, and it is
 * written up in `docs/ASSETS.md` with that reason): if a later story ever
 * narrows the boundary back toward a per-file list, deleting this line now
 * would silently delete the one exemption that was actually argued for.
 *
 * Be honest about what a test can prove here: no assertion below can fail on
 * this line's deletion, because the boundary would catch the same file anyway.
 * It is redundancy kept on purpose, and this comment is the guard.
 */
const ALPHA_EXEMPT = 'render/backdrop.ts';

/**
 * No partial alpha, page side only.
 *
 * Every other rule in this file reads CSS, and the canvas is a hole in that
 * exactly the size of `globalAlpha`. Story 4.1's sprite artist tinted a hit
 * with `globalAlpha = 0.55` over the whole 600x600 sprite frame: a translucent
 * surface, painting a red pane across a third of the arena. Nothing saw it,
 * because it is a canvas call rather than a declaration.
 *
 * Story 11.1 scopes the rule to the page rather than deleting it. The 4.1
 * defect stays caught everywhere the ruling did not release -- `hero/raster.ts`
 * is a canvas too, and it is page chrome.
 *
 * The value is **extracted and compared, not pattern-matched around**, for the
 * same reason `rounds no corner` is. The original rule was
 * `/globalAlpha\s*=\s*(?!1\b)/`, and a negative lookahead against a literal
 * misses two shapes that are not hypothetical:
 *
 * - `globalAlpha = 1 - fade` -- the lookahead sees `1`, declines to report, and
 *   a one-minus fade is the single most common way to write exactly the
 *   translucent draw this rule exists to stop.
 * - `globalAlpha: 0.5,` -- an object-literal or spread surface rather than an
 *   assignment. `hero/raster.ts:129` really does write `globalAlpha: 1,`, so
 *   the property form is how a page-side file composites in this codebase, and
 *   `=`-only matching left it entirely uncovered.
 *
 * Both are caught now: an *assignment* whose value is not exactly `1` is
 * reported, in every spelling of the assignment this app can reach --
 * `ctx.globalAlpha =`, `globalAlpha:` and `ctx['globalAlpha'] =`. What it
 * cannot see is a write that never names the property in source, such as
 * `ctx[k] = 0.5` behind a `const k = 'globalAlpha'`, or a `setAlpha(0.5)`
 * helper. That is the standing limit of a text sweep and it is written down
 * here rather than left to be discovered.
 *
 * Three further shapes are handled, and each of them was a way this rule could
 * be wrong in one direction or the other:
 *
 * - **Every** assignment on a line, not the first. `.exec` returns one match,
 *   so `ctx.globalAlpha = 1; ctx.globalAlpha = 0.35;` read as opaque -- the
 *   value the rule inspected was the one that had already been overwritten.
 * - A value **continued on the next line**, which is what the formatter does
 *   to a long right-hand side. A per-line read finds no value at all there, so
 *   a rule that stopped at the line boundary would fail open on exactly the
 *   assignments too long to eyeball.
 * - `1.0`, `1 as const` and `number | undefined`, none of which are draws, and
 *   all of which a literal string comparison reported. A rule that fails on
 *   code nobody can rewrite gets deleted rather than obeyed.
 */
function alphaOffences(files: readonly StyledFile[]): readonly string[] {
  const offences: string[] = [];
  for (const { path, source } of files) {
    // The named exemption is tested first so it is live rather than shadowed by
    // the boundary check below -- see `ALPHA_EXEMPT`'s own comment.
    if (path === ALPHA_EXEMPT || isReleased(path)) {
      continue;
    }
    const original = source.split('\n');
    const lines = stripComments(source).split('\n');
    for (const [index, line] of lines.entries()) {
      // `ctx['globalAlpha'] = 0.5` is the same draw written through a computed
      // member access, and a rule that reads the dotted form only is a rule
      // with a one-bracket bypass.
      for (const match of line.matchAll(/globalAlpha(?:\s*['"`]\s*\])?\s*[=:]\s*([^;,\n]*)/g)) {
        // An empty capture means the value is on a following line -- and the
        // *next* line can itself be a comment the stripper just blanked, so
        // the first line with anything on it is the one to read.
        const continued = lines.slice(index + 1).find((next) => next.trim() !== '') ?? '';
        const raw = match[1].trim() === '' ? continued : match[1];
        // `{ globalAlpha: 1 }` closes its literal on the same line; the closer
        // is punctuation, not part of the value.
        const value = initialiser(
          raw
            .replace(/;\s*$/, '')
            .replace(/[)}\]]+\s*$/, '')
            .replace(/\s+/g, ' ')
            .trim(),
        );
        // `if (ctx.globalAlpha === 1)` reads the property; it does not set it.
        // The `[=:]` above consumes the first `=` of `===`, so the remainder
        // starting in `=` is how a comparison is told from an assignment.
        if (value.startsWith('=')) {
          continue;
        }
        if (value !== '' && (isOpaque(value) || isTypeShape(value))) {
          continue;
        }
        offences.push(`${path}:${String(index + 1)}: ${original[index].trim()}`);
      }
    }
  }
  return offences;
}

/**
 * The only blend mode page chrome may composite with.
 *
 * `'source-over'` is the canvas default, so writing it is a no-op and a file
 * that wants to be explicit about not blending is not violating anything.
 * Everything else -- `'lighter'`, `'multiply'`, `'screen'`, `'overlay'` -- is a
 * translucent surface by another name, which is exactly what the page side is
 * not allowed to have.
 */
const OPAQUE_COMPOSITE = 'source-over';

/**
 * No blend mode outside the arena, page side only. Story 11.2.
 *
 * The sibling of `alphaOffences`, and it exists for a reason that is one
 * sentence long: that rule's own docblock says the canvas is a hole in the CSS
 * rules "exactly the size of `globalAlpha`", and Story 11.2 widened the hole by
 * adding `globalCompositeOperation` to `canvas2d.ts`. A second knob that
 * composites arbitrary pixels onto page chrome, with no sweep pointed at it, is
 * the Story 4.1 defect class reopened -- a blended pane over the landing hero
 * that no declaration-level rule can see, because it is a canvas call rather
 * than a declaration.
 *
 * Inside the arena it is released for the same reason translucency is: impact
 * *is* light, `juice-draw.ts` sets `'lighter'` around its sprite loop, and
 * Story 11.4's Ultimate will want the same. `render/theme.ts` stays kept, as it
 * does under every other released rule.
 *
 * The value is extracted and compared rather than pattern-matched around, and
 * the extraction is `alphaOffences`' one character for character: the property
 * arrives here in exactly the same three spellings (`ctx.x =`, `x:` in an
 * object literal, `ctx['x'] =`), through the same formatter wrapping, beside
 * the same explanatory comments. A cheaper regex here would have the holes that
 * rule already paid to close.
 */
function compositeOffences(files: readonly StyledFile[]): readonly string[] {
  const offences: string[] = [];
  for (const { path, source } of files) {
    if (isReleased(path)) {
      continue;
    }
    const original = source.split('\n');
    const lines = stripComments(source).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(
        /globalCompositeOperation(?:\s*['"`]\s*\])?\s*[=:]\s*([^;,\n]*)/g,
      )) {
        const continued = lines.slice(index + 1).find((next) => next.trim() !== '') ?? '';
        const raw = match[1].trim() === '' ? continued : match[1];
        const value = raw
          .replace(/;\s*$/, '')
          .replace(/[)}\]]+\s*$/, '')
          .replace(/\s+/g, ' ')
          .trim();
        // `=== 'lighter'` reads the property; it does not set it. The `[=:]`
        // above consumes the first `=` of `===`.
        if (value.startsWith('=')) {
          continue;
        }
        // A declared shape on an interface (`globalCompositeOperation: string`)
        // is the port, not a draw.
        if (/^(readonly\s+)?string(\s*\|\s*(string|undefined|null))*$/.test(value)) {
          continue;
        }
        if (value !== '' && value.replace(/^['"`]|['"`]$/g, '') === OPAQUE_COMPOSITE) {
          continue;
        }
        offences.push(`${path}:${String(index + 1)}: ${original[index].trim()}`);
      }
    }
  }
  return offences;
}

describe('the design tokens are the single source of colour', () => {
  it('keeps every hex literal in tokens.css, theme.ts or the arena palette', () => {
    expect(hexOffences(styledFiles())).toStrictEqual([]);
  });

  it('still catches a planted hex literal on the page side', () => {
    expect(
      hexOffences([{ path: 'landing/panel.ts', source: "ctx.fillStyle = '#ffd24a';" }]),
    ).toStrictEqual(['landing/panel.ts: #ffd24a']);
  });

  it('still catches a planted hex literal inside the arena', () => {
    // The rule the arena is *not* released from. Story 11.1 gave the arena a
    // second palette, and a palette only means anything if the alternative --
    // typing the colour where it is used -- still fails.
    expect(
      hexOffences([{ path: 'render/juice-draw.ts', source: "ctx.fillStyle = '#FFD24A';" }]),
    ).toStrictEqual(['render/juice-draw.ts: #FFD24A']);
  });

  it('permits hex literals in the arena palette module itself', () => {
    expect(
      hexOffences([{ path: 'render/arena-palette.ts', source: "gold: '#ffd24a'," }]),
    ).toStrictEqual([]);
  });

  it('mirrors every canvas colour back to a token, so the two cannot drift', () => {
    // The canvas cannot cheaply read a CSS custom property, so theme.ts holds
    // a copy. A copy nobody checks is a second source of truth; this is the
    // check.
    //
    // The arena palette is deliberately *not* mirrored: it is not brand, so
    // there is no token for it to drift from. What keeps it honest is that it
    // is one module rather than a hex at every call site, which the rule above
    // enforces.
    const tokens = tokensCss().toLowerCase();
    for (const colour of [THEME.bg, THEME.ink, THEME.accent, THEME.warn, THEME.muted]) {
      expect(tokens).toContain(colour.toLowerCase());
    }
  });

  it('keeps the canvas border width and shadow offset equal to the tokens', () => {
    const tokens = tokensCss();
    expect(tokens).toContain(`--tb-border-width: ${String(THEME.borderWidth)}px`);
    expect(tokens).toContain(`--tb-shadow-offset: ${String(THEME.shadowOffset)}px`);
  });

  it('pins the anti-flash colour in index.html to the ground token', () => {
    // index.html declares the ground colour inline so the first paint is
    // already dark. It is the one hex outside the colour sources, and it
    // must be the same one.
    const html = readFileSync(join(APP, 'index.html'), 'utf8');
    const found = html.match(HEX) ?? [];
    expect(found.map((value) => value.toLowerCase())).toStrictEqual([THEME.bg.toLowerCase()]);
  });
});

describe('neubrutalism, as rules rather than adjectives', () => {
  it('blurs no shadow', () => {
    // A blurred shadow is the single fastest way to make this look generic.
    // Matches `Npx Npx Npx` where the third value is non-zero, in any file.
    //
    // Not scoped to the page by Story 11.1, and it did not need to be: the
    // pattern is anchored on the CSS `box-shadow:` declaration, so the
    // canvas's own `shadowBlur` property was never covered by it. The audit
    // that produced the boundary checked this explicitly rather than assuming.
    const blurred = /box-shadow:[^;]*\b\d+px\s+\d+px\s+(?!0\b)\d/;
    const offences = styledFiles()
      .filter(({ source }) => blurred.test(source))
      .map(({ path }) => path);
    expect(offences).toStrictEqual([]);
  });

  it('uses no translucent or blurred surface on the page side', () => {
    expect(translucencyOffences(styledFiles())).toStrictEqual([]);
  });

  it('still catches a planted translucent surface in a stylesheet', () => {
    expect(
      translucencyOffences([{ path: 'styles/app.css', source: 'background: rgba(0,0,0,.5);' }]),
    ).toStrictEqual(['styles/app.css']);
  });

  it('still catches a planted gradient on the page side', () => {
    expect(
      translucencyOffences([{ path: 'hero/hero.ts', source: 'background: linear-gradient(#000, #fff);' }]),
    ).toStrictEqual(['hero/hero.ts']);
  });

  it('lets the arena glow', () => {
    // The whole point of Story 11.1, as one assertion: the exact source text
    // that fails on the page passes inside the boundary.
    expect(
      translucencyOffences([
        {
          path: 'render/juice-draw.ts',
          source: 'const glow = "radial-gradient(rgba(255,210,74,0.8), transparent)";',
        },
      ]),
    ).toStrictEqual([]);
  });

  it('says nothing about a page-side comment that merely names a banned surface', () => {
    // Story 11.1 wrote "translucency is banned outside the arena" into page-side
    // source as prose. A rule that reports its own documentation is a rule the
    // next writer routes around instead of obeying -- the same reason
    // `alphaOffences` strips comments.
    expect(
      translucencyOffences([
        { path: 'hero/raster.ts', source: '// was background: rgba(0,0,0,.5), before 4.1\ndraw();' },
      ]),
    ).toStrictEqual([]);
    expect(
      translucencyOffences([{ path: 'styles/app.css', source: '/* linear-gradient(#000,#fff) */' }]),
    ).toStrictEqual([]);
    // And the real declaration on the same file still fails.
    expect(
      translucencyOffences([
        { path: 'styles/app.css', source: '/* explained */\nbackground: rgba(0,0,0,.5);' },
      ]),
    ).toStrictEqual(['styles/app.css']);
  });

  it('rounds no corner', () => {
    // The value is extracted and compared rather than pattern-matched around.
    // A negative lookahead after `\s*` has a backtracking hole -- the quantifier
    // collapses to zero width and the lookahead then tests the leading space,
    // which passes for every input. That version of this test reported
    // `border-radius: var(--tb-radius)` as a violation of itself.
    //
    // Like `blurs no shadow`, this stayed unscoped in Story 11.1 because it
    // matches the CSS `border-radius:` declaration only -- a rounded path on
    // the canvas was never covered by it and needs nothing from the boundary.
    const offences: string[] = [];
    for (const { path, source } of styledFiles()) {
      for (const match of source.matchAll(/border-radius:\s*([^;]+);/g)) {
        const value = match[1].trim();
        if (value !== '0' && value !== 'var(--tb-radius)') {
          offences.push(`${path}: ${value}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
    expect(tokensCss()).toContain('--tb-radius: 0');
  });

  it('never removes a focus ring', () => {
    const offences = styledFiles()
      .filter(({ source }) => /outline:\s*(none|0)\b/.test(source))
      .map(({ path }) => path);
    expect(offences).toStrictEqual([]);
    expect(readFileSync(join(SRC, 'styles', 'app.css'), 'utf8')).toContain(':focus-visible');
  });

  it('steps every transition and honours reduced motion', () => {
    const appCss = readFileSync(join(SRC, 'styles', 'app.css'), 'utf8');
    // `step-end` rather than an easing curve: motion is a state change here,
    // not a journey. And nothing may vary per Match (INV-3).
    for (const declaration of appCss.match(/transition:[^;]*/g) ?? []) {
      if (declaration.includes('none')) {
        continue;
      }
      expect(declaration).toContain('step-end');
      expect(declaration).toContain('var(--tb-step)');
    }
    expect(appCss).toContain('prefers-reduced-motion: reduce');
    expect(tokensCss()).toContain('prefers-reduced-motion: reduce');
  });

  it('declares the two chosen faces and no third family', () => {
    const tokens = tokensCss();
    expect(tokens).toContain('Bricolage Grotesque');
    expect(tokens).toContain('Departure Mono');

    // `@font-face` blocks name a family because that is what defines it; the
    // rule is about *consumers*, which must all go through a token. Stripping
    // the at-rules first is the difference between a check on how type is
    // applied and a check that forbids declaring type at all.
    //
    // Story 11.1 left this rule alone on both sides of the boundary, and that
    // is a decision rather than an oversight. An arcade display face for HUD
    // numerals is a real want, and Story 11.3 must either draw it from a glyph
    // table the way `hero/font.ts` already does, or add a third `@font-face`
    // *and* amend this rule and `docs/ASSETS.md` in the same change. It may
    // not simply drift in behind the boundary.
    const withoutFontFace = (source: string): string => source.replace(/@font-face\s*\{[^}]*\}/g, '');

    const families = new Set(
      styledFiles()
        .flatMap(({ source }) => withoutFontFace(source).match(/font-family:\s*([^;]+);/g) ?? [])
        .filter((declaration) => !declaration.includes('var(--tb-font-')),
    );
    expect([...families]).toStrictEqual([]);

    // And exactly the two faces are ever defined -- a third @font-face is how a
    // second display family arrives without anyone deciding to add one.
    //
    // Counted across **every** stylesheet the app ships, not across the two
    // this rule happened to be written against. `docs/DESIGN.md` says a third
    // family "may not drift in behind the boundary"; a count scoped to
    // `tokens.css` and `app.css` would have let Story 11.3 add
    // `styles/arcade.css` and drift in exactly that way.
    const declared = styledFiles()
      .filter(({ path }) => path.endsWith('.css'))
      .flatMap(({ source }) => source.match(/@font-face/g) ?? []);
    expect(declared).toHaveLength(2);

    // And the canvas, which is the one place the two checks above cannot see.
    //
    // A canvas takes a font *shorthand string*, not a `font-family` declaration
    // and not a token, so `THEME.arcadeFont = "800 16px 'Retro Arcade'"` would
    // satisfy every assertion above while putting a third family on screen.
    // Story 11.3 is the story that added an arcade treatment and it took the
    // display face at a smaller size precisely so this stayed true; the check
    // is here so the next story cannot quietly take the other route.
    //
    // Quoted families must be in `tokens.css`. Unquoted ones are generic or
    // system keywords -- `sans-serif`, `ui-monospace`, `monospace` -- which are
    // fallbacks rather than faces and are what the two token stacks already
    // end in.
    for (const shorthand of [THEME.displayFont, THEME.monoFont, THEME.arcadeFont]) {
      for (const quoted of shorthand.match(/'([^']+)'/g) ?? []) {
        expect(tokens).toContain(quoted.slice(1, -1));
      }
      const unquoted = shorthand
        .slice(shorthand.indexOf('px ') + 3)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => !part.startsWith("'"));
      for (const generic of unquoted) {
        expect(['sans-serif', 'serif', 'monospace', 'ui-monospace', 'system-ui']).toContain(generic);
      }
    }

    // The other half of the same hole: consumers are allowed through when they
    // read a `--tb-font-*` token, so a *third token* is a third family with the
    // filter above satisfied. These are the two that exist.
    //
    // Scanned across every shipped stylesheet for the same reason the
    // `@font-face` count is: a token declared in `styles/arcade.css` is as
    // usable as one declared in `tokens.css`, and reading only `tokens.css`
    // would leave the hole open in the file a new story is most likely to add.
    const fontTokens = styledFiles()
      .filter(({ path }) => path.endsWith('.css'))
      .flatMap(({ source }) => [...source.matchAll(/(--tb-font-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    expect([...new Set(fontTokens)].sort()).toStrictEqual(['--tb-font-display', '--tb-font-mono']);
  });
});

describe('the page canvas obeys the same rules as the stylesheet', () => {
  it('sets no partial alpha outside the arena', () => {
    expect(alphaOffences(styledFiles())).toStrictEqual([]);
  });

  it('still catches a planted partial alpha on the page side', () => {
    // Story 4.1's actual defect, reduced to one line. `hero/` draws to a
    // canvas too, and it is page chrome, so the rule that caught the red pane
    // over the arena still stands over it.
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'ctx.globalAlpha = 0.5;' }]),
    ).toStrictEqual(['hero/raster.ts:1: ctx.globalAlpha = 0.5;']);
  });

  it('catches a page-side partial alpha written as a property rather than an assignment', () => {
    // `hero/raster.ts` composites through an object literal, not `ctx.x = y`,
    // so an `=`-only rule never covered the shape this app actually uses.
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'globalAlpha: 0.5,' }]),
    ).toStrictEqual(['hero/raster.ts:1: globalAlpha: 0.5,']);
  });

  it('catches a page-side one-minus fade, which a literal lookahead lets through', () => {
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'ctx.globalAlpha = 1 - fade;' }]),
    ).toStrictEqual(['hero/raster.ts:1: ctx.globalAlpha = 1 - fade;']);
  });

  it('leaves a fully opaque page-side assignment alone', () => {
    // `hero/raster.ts` really does assign `globalAlpha: 1`, and always did.
    // The rule is about *partial* alpha; a rule that failed on `= 1` would be
    // a rule nobody could satisfy.
    expect(alphaOffences([{ path: 'hero/raster.ts', source: 'globalAlpha: 1,' }])).toStrictEqual([]);
    expect(alphaOffences([{ path: 'hero/raster.ts', source: 'ctx.globalAlpha = 1;' }])).toStrictEqual([]);
  });

  it('leaves a port type declaration alone', () => {
    // `globalAlpha: number` on an interface is a shape, not a draw.
    expect(
      alphaOffences([{ path: 'player/clock.ts', source: '  globalAlpha: number;' }]),
    ).toStrictEqual([]);
  });

  it('permits the same line inside the arena', () => {
    expect(
      alphaOffences([{ path: 'render/juice-draw.ts', source: 'ctx.globalAlpha = 0.5;' }]),
    ).toStrictEqual([]);
  });

  it('reads every assignment on a line, not only the first', () => {
    // `save(); globalAlpha = 1; ... globalAlpha = 0.35` on one line: the first
    // value is the one that was overwritten, so a rule that stops there reads
    // the draw as opaque and ships the exact Story 4.1 defect.
    expect(
      alphaOffences([
        { path: 'hero/raster.ts', source: 'ctx.globalAlpha = 1; ctx.globalAlpha = 0.35;' },
      ]),
    ).toHaveLength(1);
  });

  it('catches a page-side value the formatter wrapped onto the next line', () => {
    // A long right-hand side is exactly the assignment nobody eyeballs, and a
    // per-line read finds no value on the `=` line at all.
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'ctx.globalAlpha =\n  1 - fade;' }]),
    ).toStrictEqual(['hero/raster.ts:1: ctx.globalAlpha =']);
  });

  it('says nothing about a comment that merely mentions the rule', () => {
    // Prose about a rule is not a violation of it, and a rule that reports its
    // own documentation is one nobody can write down.
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'draw(); // was ctx.globalAlpha = 0.4' }]),
    ).toStrictEqual([]);
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: '/* ctx.globalAlpha = 0.4 */\ndraw();' }]),
    ).toStrictEqual([]);
  });

  it('catches a page-side alpha written through a computed member access', () => {
    // `ctx['globalAlpha'] = 0.5` is the same draw as `ctx.globalAlpha = 0.5`,
    // and a rule that reads the dotted form only has a one-bracket bypass.
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: "ctx['globalAlpha'] = 0.5;" }]),
    ).toHaveLength(1);
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'ctx["globalAlpha"] = 1;' }]),
    ).toStrictEqual([]);
  });

  it('says nothing about a line that reads globalAlpha rather than setting it', () => {
    // `===` begins with the `=` the rule matches on. Reporting a *read* of the
    // property is a rule nobody can satisfy except by not reading it.
    for (const source of [
      'if (ctx.globalAlpha === 1) { return; }',
      'expect(ctx.globalAlpha == 1).toBe(true);',
      'if (ctx.globalAlpha !== 1) { return; }',
    ]) {
      expect(alphaOffences([{ path: 'hero/raster.ts', source }])).toStrictEqual([]);
    }
  });

  it('reads the initialiser of an annotated field, not its annotation', () => {
    // `globalAlpha: number = 1` is a type *and* a value on one line. The value
    // is what the rule is about, and it must still be the thing compared.
    expect(
      alphaOffences([{ path: 'player/clock.ts', source: '  readonly globalAlpha: number = 1;' }]),
    ).toStrictEqual([]);
    expect(
      alphaOffences([{ path: 'player/clock.ts', source: '  globalAlpha: number = 0.5;' }]),
    ).toHaveLength(1);
  });

  it('reads past a comment the stripper blanked to find a wrapped value', () => {
    // The formatter wraps the value; someone then explains the wrap. The
    // blanked comment line is not the value, and stopping on it read the
    // assignment as having none at all.
    expect(
      alphaOffences([
        { path: 'hero/raster.ts', source: 'ctx.globalAlpha =\n  // the fade, inverted\n  1 - fade;' },
      ]),
    ).toHaveLength(1);
  });

  it('leaves the other spellings of fully opaque alone', () => {
    // Each of these was reported by a literal `!== '1'` comparison, and none of
    // them is a translucent draw. A rule that fails on code nobody can rewrite
    // gets deleted rather than obeyed.
    for (const source of [
      'ctx.globalAlpha = 1.0;',
      'const c = { globalAlpha: 1 };',
      'globalAlpha: 1 as const,',
      'globalAlpha: 1 as number,',
      'globalAlpha: 1 satisfies number,',
      '  readonly globalAlpha: number | undefined;',
    ]) {
      expect(alphaOffences([{ path: 'hero/raster.ts', source }])).toStrictEqual([]);
    }
  });

  it('sets no blend mode outside the arena', () => {
    expect(compositeOffences(styledFiles())).toStrictEqual([]);
  });

  it('still catches a planted blend mode on the page side', () => {
    // Story 11.2 widened the port with `globalCompositeOperation`, and a blend
    // mode on page chrome is a translucent surface written as a canvas call --
    // the Story 4.1 shape, through the knob that arrived after that rule.
    expect(
      compositeOffences([{ path: 'hero/raster.ts', source: "ctx.globalCompositeOperation = 'lighter';" }]),
    ).toStrictEqual(["hero/raster.ts:1: ctx.globalCompositeOperation = 'lighter';"]);
  });

  it('catches a page-side blend mode written as a property rather than an assignment', () => {
    // `hero/raster.ts` composites through an object literal, which is exactly
    // where its own `globalCompositeOperation` entry lives.
    expect(
      compositeOffences([{ path: 'hero/raster.ts', source: "globalCompositeOperation: 'multiply'," }]),
    ).toHaveLength(1);
    expect(
      compositeOffences([{ path: 'hero/raster.ts', source: "ctx['globalCompositeOperation'] = 'screen';" }]),
    ).toHaveLength(1);
  });

  it('leaves source-over and the port declaration alone on the page side', () => {
    // The default written explicitly is not a blend, and a rule that failed on
    // it would fail on the one page-side file that says out loud that it does
    // not blend. The interface shape in `canvas2d.ts` is not a draw either.
    for (const source of [
      "globalCompositeOperation: 'source-over',",
      "ctx.globalCompositeOperation = 'source-over';",
      '  globalCompositeOperation: string;',
      "if (ctx.globalCompositeOperation === 'lighter') { return; }",
      "draw(); // was ctx.globalCompositeOperation = 'lighter'",
    ]) {
      expect(compositeOffences([{ path: 'hero/raster.ts', source }])).toStrictEqual([]);
    }
  });

  it('permits the same line inside the arena', () => {
    // `juice-draw.ts` really does set `'lighter'` around its impact loop.
    // Impact is light, and Story 11.1 released the arena to say so.
    expect(
      compositeOffences([{ path: 'render/juice-draw.ts', source: "ctx.globalCompositeOperation = 'lighter';" }]),
    ).toStrictEqual([]);
    // And the brand mirror is not released, here as under every other rule.
    expect(
      compositeOffences([{ path: BRAND_MIRROR, source: "ctx.globalCompositeOperation = 'lighter';" }]),
    ).toHaveLength(1);
  });

  it('does not release the brand mirror, which sits inside the boundary', () => {
    // `render/theme.ts` is under `render/` but it is the page's five flat
    // colours. Releasing the file that defines flatness from the flatness
    // rules is the boundary leaking, not the boundary working.
    expect(isArena(BRAND_MIRROR)).toBe(true);
    expect(isReleased(BRAND_MIRROR)).toBe(false);
    expect(
      translucencyOffences([{ path: BRAND_MIRROR, source: 'const g = "linear-gradient(#000,#fff)";' }]),
    ).toStrictEqual([BRAND_MIRROR]);
    expect(
      alphaOffences([{ path: BRAND_MIRROR, source: 'ctx.globalAlpha = 0.5;' }]),
    ).toHaveLength(1);
  });

  it('does not release a stylesheet that happens to sit under render/', () => {
    // The boundary is about the canvas. A stylesheet cannot draw on one, so
    // `render/hud.css` is page chrome wearing the arena's directory name.
    expect(isArena('render/hud.css')).toBe(false);
    expect(
      translucencyOffences([{ path: 'render/hud.css', source: 'background: rgba(0,0,0,.5);' }]),
    ).toStrictEqual(['render/hud.css']);
  });

  it('keeps the named backdrop exemption, and checks it before the boundary', () => {
    // The exemption is redundant -- `backdrop.ts` is inside the boundary, so
    // no assertion here can fail on its deletion, and claiming otherwise would
    // be a test that lies about what it guards. What is asserted is the two
    // facts that make keeping it coherent: the file is inside the boundary,
    // and the exemption arm still admits it on its own terms.
    expect(isArena(ALPHA_EXEMPT)).toBe(true);
    expect(alphaOffences([{ path: ALPHA_EXEMPT, source: 'ctx.globalAlpha = 0.55;' }])).toStrictEqual([]);
  });
});

describe('the arena boundary is named, documented, and still swept for clocks', () => {
  it('holds exactly these files, so nothing joins the arena unnoticed', () => {
    // An exact list rather than `arrayContaining`, and the difference matters.
    // The boundary itself is a directory prefix, because an allowlist that
    // 11.2, 11.3, 11.4 and 11.6 each have to edit is not a boundary. But a
    // subset assertion can never fail, so `git mv page-thing.ts render/`
    // would release a page file from three rules with no test and no review
    // signal. This list is the ratchet: joining the arena stays a one-line,
    // deliberate, reviewable act rather than a side effect of where a file
    // was put.
    expect([...arenaFiles().map(({ path }) => path)].sort()).toStrictEqual([
      'render/animation.ts',
      'render/arena-palette.ts',
      'render/artist.ts',
      'render/audio-bus.ts',
      'render/audio.ts',
      'render/backdrop.ts',
      'render/canvas2d.ts',
      // Story 11.3. The arcade HUD's drawing: bevels, banded ramps and a
      // damage-lag ghost, none of which are brand colours and all of which the
      // owner's 2026-08-07 ruling puts on the game side of the fence.
      'render/hud.ts',
      'render/identity.ts',
      'render/juice-draw.ts',
      'render/juice.ts',
      'render/renderer.ts',
      'render/sprite-sheet.ts',
      'render/theme.ts',
      // Story 11.2. The impact FX sheet: arena by definition -- it exists only
      // to describe art the fight is drawn with -- and joining the list is the
      // deliberate, reviewable act this ratchet exists to require.
      'render/vfx-sheet.ts',
    ]);
  });

  it('agrees with the walk about what a TypeScript file is', () => {
    // The membership ratchet above is only a ratchet over files the walk
    // collects, and only the boundary decides which of those are arena. If the
    // two disagree on an extension, a file in the gap is in neither list and no
    // rule in this suite -- released or kept -- applies to it at all.
    for (const name of ['render/hud.tsx', 'render/hud.mts', 'render/hud.cts']) {
      expect(isArena(name)).toBe(true);
      expect(
        alphaOffences([{ path: 'hero/hud.tsx', source: 'ctx.globalAlpha = 0.5;' }]),
      ).toHaveLength(1);
    }
    expect(isArena('render/hud.css')).toBe(false);
    // And in the real tree there is no third case: every file the walk collects
    // under `render/` is either arena or a stylesheet, which is exactly the two
    // outcomes the boundary defines. A file that is neither would be one the
    // walk reached and the boundary could not classify.
    const underRender = styledFiles().filter(({ path }) => path.startsWith(ARENA_BOUNDARY));
    expect(underRender.length).toBeGreaterThan(0);
    for (const { path } of underRender) {
      expect(isArena(path) || path.endsWith('.css')).toBe(true);
    }
  });

  it('leaves the page-side canvas in `hero/` on the page side', () => {
    // The one non-obvious call. `hero/` drives a canvas too, but what it
    // produces is a landing-page asset rather than a surface a Match is played
    // on, so it keeps every flat-surface rule. Asserted against the real tree
    // rather than against `arenaFiles()` -- a path cannot start with both
    // prefixes, so checking that inside the arena list would be a tautology.
    const heroFiles = styledFiles().filter(({ path }) => path.startsWith('hero/'));
    expect(heroFiles.length).toBeGreaterThan(0);
    for (const { path } of heroFiles) {
      expect(isArena(path)).toBe(false);
    }
    // And the rules really do still bite there.
    expect(
      alphaOffences([{ path: 'hero/raster.ts', source: 'ctx.globalAlpha = 0.4;' }]),
    ).toHaveLength(1);
  });

  it('reads no wall clock anywhere inside the arena (INV-3)', () => {
    // Story 11.1 relaxed *style* rules only. `source-discipline.test.ts` is
    // what makes the benchmark's claims true and it is byte-unchanged by this
    // story -- but "unchanged" and "still covering the arena" are two
    // different claims, and only the first is visible in a diff. This is the
    // second one, run here so that widening the arena's visual freedom can
    // never be mistaken for widening its freedom to schedule.
    const wallClock =
      /\b(Date\.now|performance\.now|new Date\(|Date\.parse|process\.hrtime|setInterval|setTimeout|currentTime)\b/;

    // The same pattern, character for character, as the one that file sweeps
    // with. Duplicated rather than imported, because importing a test module
    // would run its suites; pinned by this assertion so the duplicate cannot
    // silently fall behind the original.
    expect(sourceDisciplineSource()).toContain(wallClock.source);

    const offences: string[] = [];
    for (const { path, source } of arenaFiles()) {
      for (const [index, line] of source.split('\n').entries()) {
        const trimmed = line.trim();
        if (
          trimmed.length === 0 ||
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          continue;
        }
        if (wallClock.test(line)) {
          offences.push(`${path}:${String(index + 1)}: ${trimmed}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('adds no arena path to the wall-clock exemption list', () => {
    // The exemption list in `source-discipline.test.ts` is the one place a
    // `render/` path could be quietly parked to buy a clock. Asserted by
    // reading that file's source, which is how "unchanged" is proved without
    // editing it.
    const exemptions = /const WALL_CLOCK_EXEMPT = \[([^\]]*)\]/.exec(sourceDisciplineSource());
    expect(exemptions).not.toBeNull();
    expect(exemptions?.[1]).not.toContain(ARENA_BOUNDARY);
    expect(exemptions?.[1]).toContain('spectate/manifest.ts');

    // `offendingLines(pattern, exempt)` takes an arbitrary list, so a second
    // exemption array would be a second place a `render/` path could be
    // parked -- invisible to the check above, which only reads the one it
    // knows the name of. There is exactly one exempted sweep, and this is it.
    //
    // Asserted as a ban on the *string* outside that file's one coverage list,
    // not by matching `offendingLines(..., IDENT)`. That regex saw only a
    // single-line call passing a named constant, so an inline array
    // (`offendingLines(p, ['render/x.ts'])`) or a formatter-wrapped argument
    // list -- the two shapes an exemption is most likely to actually arrive in
    // -- were both invisible to the check written to catch them. A guard has to
    // be checked against the hole rather than against the tidy case.
    const source = sourceDisciplineSource();
    // The cut is anchored on this string; if it is ever reformatted away the
    // whole file is scanned and this test fails loudly on the coverage list
    // itself, which is a visible prompt to re-anchor rather than a silent pass.
    expect(source).toContain(COVERAGE_LIST_OPENER);
    const parked = stripComments(outsideCoverageList(source))
      .split('\n')
      .filter((line) => /['"`]render\//.test(line));
    expect(parked).toStrictEqual([]);
  });

  it('would see a render path parked in any shape of exemption', () => {
    // The planted case for the assertion above, which otherwise only ever
    // reports that today's file is clean. Each of these is a way an exemption
    // arrives that the previous `offendingLines(..., IDENT)` matcher missed:
    // an inline array, a second named constant, and a wrapped argument list.
    const parked = (source: string): readonly string[] =>
      stripComments(outsideCoverageList(source))
        .split('\n')
        .filter((line) => /['"`]render\//.test(line));

    const coverage = `expect.arrayContaining([\n  'render/renderer.ts',\n]);\n`;
    expect(parked(coverage)).toStrictEqual([]);
    expect(parked(`${coverage}offendingLines(wallClock, ['render/juice.ts']);`)).toHaveLength(1);
    expect(
      parked(`${coverage}const SECOND_EXEMPT = ['render/juice.ts'];\noffendingLines(p, SECOND_EXEMPT);`),
    ).toHaveLength(1);
    expect(parked(`${coverage}offendingLines(\n  wallClock,\n  ['render/juice.ts'],\n);`)).toHaveLength(1);
    // A citation in prose is not a parked path.
    expect(parked(`${coverage}// see 'render/juice.ts' for why\n`)).toStrictEqual([]);
  });

  it('leaves the shipped-source walk skipping only testing/ and dev/', () => {
    // The other way an arena file could leave the sweep: not by exemption but
    // by the walk never reaching it. Those two directories are Node-only
    // tooling that never enters the bundle; a third name here would mean a
    // shipped directory had been dropped from the sweep.
    // Quote-agnostic, so a cosmetic reformat of that file does not fail this
    // one for a reason unrelated to the invariant it protects.
    const skipped = [...sourceDisciplineSource().matchAll(/entry\.name === ['"`]([^'"`]+)['"`]/g)].map(
      (match) => match[1],
    );
    expect(skipped).toStrictEqual(['testing', 'dev']);
    expect(skipped).not.toContain('render');
  });
});

describe('the arena palette declares colour once', () => {
  /** Every colour in the palette, gradient stops and auras flattened out. */
  function paletteColours(): readonly string[] {
    const flat: string[] = [];
    for (const value of Object.values(ARENA_PALETTE) as readonly unknown[]) {
      if (typeof value === 'string') {
        flat.push(value);
        continue;
      }
      // A numeric or boolean top-level entry would reach `Object.values` as a
      // boxed primitive with no own properties, contributing nothing and
      // skipping the `#rrggbb` shape check in silence.
      expect(typeof value).toBe('object');
      expect(value).not.toBeNull();
      for (const nested of Object.values(value as Record<string, unknown>)) {
        // Asserted rather than cast. A third level of nesting, or a numeric
        // leaf, would otherwise enter the Set below as an object identity and
        // make `declares each colour once` pass vacuously.
        expect(typeof nested).toBe('string');
        flat.push(nested as string);
      }
    }
    return flat;
  }

  it('writes every value as a lowercase #rrggbb', () => {
    // One shape, so a consumer never has to branch on `#rgb` versus `#rrggbb`
    // versus an eight-digit value carrying its own alpha. Alpha in the arena
    // belongs to the draw call, not to the colour.
    for (const colour of paletteColours()) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('declares each colour once', () => {
    // A duplicated value means two names for one colour, which is how a
    // palette starts drifting back toward literals at call sites.
    const colours = paletteColours();
    expect(colours.length).toBeGreaterThan(0);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('keeps the HUD structure colours out of the brand, which is the whole point of two palettes', () => {
    // Story 11.3's four additions. A plate, a frame, a bevel and a ghost are
    // descriptions of *how a bar is built*, not brand decisions -- the reason
    // they are here and not in `theme.ts`. Re-declaring one of the five brand
    // values under an arena name would put the same colour in two files and
    // start exactly the drift `docs/DESIGN.md`'s two-regimes split exists to
    // prevent.
    const brand = new Set([THEME.bg, THEME.ink, THEME.accent, THEME.warn, THEME.muted]);
    for (const colour of [
      ARENA_PALETTE.hudPlate,
      ARENA_PALETTE.hudFrame,
      ARENA_PALETTE.hudBevel,
      ARENA_PALETTE.hudGhost,
    ]) {
      expect(brand.has(colour)).toBe(false);
    }
  });

  it('gives every fighter in the roster an aura', () => {
    expect(Object.keys(ARENA_PALETTE.aura)).toStrictEqual(['clawde', 'chatty', 'gemini', 'grokk']);
  });

  it('is frozen all the way down', () => {
    // Every nested value, not a sample of them: a naming-three-of-six version
    // of this test passes while a newly added gradient goes unfrozen.
    expect(Object.isFrozen(ARENA_PALETTE)).toBe(true);
    for (const value of Object.values(ARENA_PALETTE) as readonly unknown[]) {
      if (typeof value !== 'string') {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
  });

  it('keeps every hex in the palette module inside the exported palette', () => {
    // `arena-palette.ts` is exempted from the hex rule wholesale, which makes
    // it the one file where a literal could be typed at a call site with
    // nothing to catch it. Every hex in its *code* must be a value the palette
    // actually exports.
    //
    // Comments are stripped first: that file's prose cites the reference's own
    // `#111827` and the `--tb-bg` ground it was measured against, and a
    // citation is exactly the thing a provenance comment is for.
    //
    // `stripComments` rather than a leading-`//` filter, because a citation is
    // as likely to be written at the end of the line it explains as above it,
    // and a rule that reports the comment beside a colour is a rule that
    // discourages citing the colour's source.
    const source = readFileSync(join(SRC, 'render', 'arena-palette.ts'), 'utf8');
    const declared = new Set(paletteColours());
    const stray = stripComments(source)
      .split('\n')
      .flatMap((line) => line.match(HEX) ?? [])
      .filter((hex) => !declared.has(hex.toLowerCase()));
    expect(stray).toStrictEqual([]);
  });
});

describe('the boundary is written down where a reader can find it', () => {
  it('names both regimes and the boundary path in docs/DESIGN.md', () => {
    // A rule that lives only in a test is a rule nobody can look up. The
    // ruling, the boundary and the reasoning must be in the design doc in the
    // same change that moved the fence.
    const design = designDoc();
    expect(design).toContain('Two regimes');
    expect(design).toContain(`apps/web/src/${ARENA_BOUNDARY}`);
    expect(design).toContain('2026-08-07');
    expect(design).toContain('source-discipline.test.ts');
    expect(design).toContain('arena-palette.ts');
  });

  it('no longer claims tokens.css is the only source of colour without qualification', () => {
    // The Tokens section used to read "tokens.css is the single source. A hex
    // literal ... written anywhere else is a defect." That is now false for
    // one file, and a design doc that is false in one place is a design doc
    // nobody trusts in the others.
    const design = designDoc();
    expect(design).not.toContain('is the single source. A hex');
    expect(design).toContain('render/arena-palette.ts');
    // A negative assertion alone would pass against any rewording, including a
    // freshly reworded absolute claim. The positive one pins what the section
    // must actually say.
    expect(design).toContain('is where the **page** declares colour');
    // And the third place a hex legitimately lives, which the section used to
    // omit entirely.
    expect(design).toContain('apps/web/index.html');
  });
});

describe('the site renders identically offline', () => {
  it('fetches no asset from another origin', () => {
    // No font CDN, no remote stylesheet, no remote image. This is the offline
    // and CI guarantee, and it is INV-8's "no recurring cost" at the same time
    // -- a third-party host is a dependency someone else can take away.
    //
    // Unscoped by Story 11.1 and deliberately so: INV-8 holds over the arena
    // exactly as hard as over the page. The boundary released three style
    // rules, not the offline guarantee.
    const remote = /(@import\s+(url\()?['"]?https?:|url\(\s*['"]?https?:|href\s*=\s*['"]https?:|src\s*=\s*['"]https?:)/;
    const offences = [
      ...styledFiles(),
      { path: 'index.html', source: readFileSync(join(APP, 'index.html'), 'utf8') },
    ]
      .filter(({ source }) => remote.test(source))
      .map(({ path }) => path);
    expect(offences).toStrictEqual([]);
  });

  it('self-hosts both faces from this origin', () => {
    const appCss = readFileSync(join(SRC, 'styles', 'app.css'), 'utf8');
    const sources = appCss.match(/src:\s*url\([^)]*\)/g) ?? [];
    expect(sources.length).toBe(2);
    for (const declaration of sources) {
      expect(declaration).toContain("url('/fonts/");
      expect(declaration).toContain('woff2');
    }
  });
});
