import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const APP = join(SRC, '..');

/** The two files allowed to contain a colour literal, and nothing else. */
const COLOUR_SOURCES = ['styles/tokens.css', 'render/theme.ts'];

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
    if (extensions.some((extension) => entry.name.endsWith(extension)) && !entry.name.endsWith('.test.ts')) {
      collected.push({
        path: relative(SRC, full).replace(/\\/g, '/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  }
  return collected;
}

function styledFiles(): readonly StyledFile[] {
  return walk(SRC, ['.css', '.ts'], []);
}

function tokensCss(): string {
  return readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8');
}

describe('the design tokens are the single source of colour', () => {
  it('keeps every hex literal in tokens.css or theme.ts', () => {
    const offences: string[] = [];
    for (const { path, source } of styledFiles()) {
      if (COLOUR_SOURCES.includes(path)) {
        continue;
      }
      for (const match of source.match(HEX) ?? []) {
        offences.push(`${path}: ${match}`);
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('mirrors every canvas colour back to a token, so the two cannot drift', () => {
    // The canvas cannot cheaply read a CSS custom property, so theme.ts holds
    // a copy. A copy nobody checks is a second source of truth; this is the
    // check.
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
    // already dark. It is the one hex outside the two colour sources, and it
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
    const blurred = /box-shadow:[^;]*\b\d+px\s+\d+px\s+(?!0\b)\d/;
    const offences = styledFiles()
      .filter(({ source }) => blurred.test(source))
      .map(({ path }) => path);
    expect(offences).toStrictEqual([]);
  });

  it('uses no translucent or blurred surface', () => {
    const banned = /\b(rgba\(|backdrop-filter|filter:\s*blur|linear-gradient|radial-gradient|box-shadow:[^;]*inset)/;
    const offences = styledFiles()
      .filter(({ source }) => banned.test(source))
      .map(({ path }) => path);
    expect(offences).toStrictEqual([]);
  });

  it('rounds no corner', () => {
    // The value is extracted and compared rather than pattern-matched around.
    // A negative lookahead after `\s*` has a backtracking hole -- the quantifier
    // collapses to zero width and the lookahead then tests the leading space,
    // which passes for every input. That version of this test reported
    // `border-radius: var(--tb-radius)` as a violation of itself.
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
    const withoutFontFace = (source: string): string => source.replace(/@font-face\s*\{[^}]*\}/g, '');

    const families = new Set(
      styledFiles()
        .flatMap(({ source }) => withoutFontFace(source).match(/font-family:\s*([^;]+);/g) ?? [])
        .filter((declaration) => !declaration.includes('var(--tb-font-')),
    );
    expect([...families]).toStrictEqual([]);

    // And exactly the two faces are ever defined -- a third @font-face is how a
    // second display family arrives without anyone deciding to add one.
    const declared = (tokensCss() + readFileSync(join(SRC, 'styles', 'app.css'), 'utf8')).match(
      /@font-face/g,
    );
    expect(declared).toHaveLength(2);
  });
});

describe('the canvas obeys the same rules as the stylesheet', () => {
  it('sets no partial alpha outside the one place scenery is dimmed', () => {
    // Every other rule in this file reads CSS, and the canvas is a hole in that
    // exactly the size of `globalAlpha`. Story 4.1's sprite artist tinted a hit
    // with `globalAlpha = 0.55` over the whole 600x600 sprite frame: a
    // translucent surface, which docs/DESIGN.md bans outright, painting a red
    // pane across a third of the arena. Nothing here saw it, because it is a
    // canvas call rather than a declaration. Now it is one grep.
    //
    // `backdrop.ts` is the single exemption and it is named rather than
    // pattern-matched: dimming the scenery composites once to a flat opaque
    // image, it is recorded in docs/ASSETS.md with its reason, and it is the
    // difference between scenery and a competing subject.
    const offences: string[] = [];
    for (const { path, source } of styledFiles()) {
      if (path === 'render/backdrop.ts') {
        continue;
      }
      for (const [index, line] of source.split('\n').entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        // Assigning anything but 1 is a translucent draw.
        if (/globalAlpha\s*=\s*(?!1\b)/.test(line)) {
          offences.push(`${path}:${String(index + 1)}: ${trimmed}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});

describe('the site renders identically offline', () => {
  it('fetches no asset from another origin', () => {
    // No font CDN, no remote stylesheet, no remote image. This is the offline
    // and CI guarantee, and it is INV-8's "no recurring cost" at the same time
    // -- a third-party host is a dependency someone else can take away.
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
