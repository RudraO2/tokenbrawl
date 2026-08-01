import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Story 7.4: the README's claims, and the asset manifest's completeness, as
 * gates rather than as good intentions.
 *
 * Three of this story's acceptance criteria are claims about *words* -- no
 * novelty claim, these citations present, this disclosure present -- and the
 * fourth is a claim about a document staying true as files land beside it.
 * Prose cannot be asserted, but vocabulary and presence can, and that is the
 * half that actually regresses: a later story adds a sprite pack, or softens a
 * sentence, and nothing notices.
 *
 * It lives in `packages/cli` for the same reason `workflow-discipline.test.ts`
 * and `publication-discipline.test.ts` do: this workspace is where the
 * repository-level sweeps run from.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readme(): string {
  return readFileSync(join(ROOT, 'README.md'), 'utf8');
}

function assets(): string {
  return readFileSync(join(ROOT, 'docs', 'ASSETS.md'), 'utf8');
}

describe('the README opens with the hero (AC1)', () => {
  it('references an image before any prose, and that image exists', () => {
    const lines = readme()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // First the title, then the image. Anything between them is prose above the
    // fold that the animation was supposed to be.
    expect(lines[0]).toMatch(/^#\s/);
    expect(lines[1]).toMatch(/^!\[[^\]]*\]\(([^)]+)\)$/);

    const reference = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(lines[1]);
    expect(reference).not.toBeNull();
    const path = (reference as RegExpExecArray)[1];
    expect(existsSync(join(ROOT, path))).toBe(true);
    // A GIF is the one format GitHub animates inline with no click. An mp4 or
    // an SVG animation in this slot would silently stop being an animation.
    expect(path.endsWith('.gif')).toBe(true);
  });

  it('carries alt text describing what the animation shows', () => {
    // Empty alt text on the one image a screen reader will meet is the
    // accessibility equivalent of shipping the hero as a blank rectangle.
    const line = readme()
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)[1];
    const alt = /^!\[([^\]]*)\]/.exec(line);
    expect(alt).not.toBeNull();
    expect((alt as RegExpExecArray)[1].length).toBeGreaterThan(40);
  });

  it('says in words that the hero is a scripted stand-in, not a live model', () => {
    // The image says so on every frame; this is the half a reader who only
    // reads text still sees. Story 7.4's whole subject is honest claims, and
    // an unlabelled animation of a "model" fighting would be the first
    // dishonest one.
    const text = readme();
    expect(text).toMatch(/scripted stand-in/i);
    expect(text).toMatch(/not a live model/i);
    expect(text).toMatch(/no tournament has been run/i);
  });
});

describe('the README makes a bounded claim (AC3)', () => {
  it('states the claim this project is allowed to make', () => {
    expect(readme().replace(/\s+/g, ' ')).toContain(
      'latency-fair head-to-head harness where compute budget is an adversarial in-match resource, run with controls',
    );
  });

  it('uses no novelty vocabulary anywhere', () => {
    // AC3 forbids a novelty claim outright. Each of these is a way of making
    // one without noticing, and each is a word this README has no use for.
    const banned = [
      /\bnovel\b/i,
      /\bnovelty\b/i,
      /\bunprecedented\b/i,
      /\bgroundbreaking\b/i,
      /\brevolutionary\b/i,
      /\bbreakthrough\b/i,
      /\bstate[- ]of[- ]the[- ]art\b/i,
      /\bworld[- ]?first\b/i,
      /\bthe first \w+ to\b/i,
      /\bnever been done\b/i,
      /\bno one has\b/i,
    ];
    const offences = banned.filter((pattern) => pattern.test(readme())).map(String);
    expect(offences).toStrictEqual([]);
  });

  it('keeps a section saying what it does not claim', () => {
    expect(readme()).toMatch(/does not claim/i);
  });
});

describe('the README cites its prior work (AC4)', () => {
  it('names every work the story requires', () => {
    const text = readme();
    for (const citation of [
      'llm-colosseum',
      'Win Fast or Lose Slow',
      'NeurIPS 2025',
      'Orak',
      'TALE',
      'CostBench',
      'CATArena',
      'CodeToPlay',
      'LLM-PSRO',
    ]) {
      expect(text).toContain(citation);
    }
  });
});

describe('the README carries the ranking disclosure (AC5, INV-6)', () => {
  it('says it ranks Deployments rather than models', () => {
    expect(readme()).toMatch(/ranks Deployments, not models/i);
  });

  it('says free endpoints may serve quantised weights', () => {
    const text = readme();
    expect(text).toMatch(/free endpoints/i);
    expect(text).toMatch(/quantised weights/i);
  });
});

describe('the asset manifest is complete (AC6)', () => {
  const publicDir = join(ROOT, 'apps', 'web', 'public');

  it('records every sprite pack that is actually on disk', () => {
    const manifest = assets();
    const packs = readdirSync(join(publicDir, 'sprites')).filter((entry) =>
      statSync(join(publicDir, 'sprites', entry)).isDirectory(),
    );
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.filter((pack) => !manifest.includes(pack))).toStrictEqual([]);
  });

  it('records every typeface that is actually on disk', () => {
    const manifest = assets();
    const faces = readdirSync(join(publicDir, 'fonts')).filter((entry) => entry.endsWith('.woff2'));
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.filter((face) => !manifest.includes(face.replace('.woff2', '')))).toStrictEqual([]);
  });

  it('ships the licence text beside each sprite pack', () => {
    const spritesDir = join(publicDir, 'sprites');
    const packs = readdirSync(spritesDir).filter((entry) =>
      statSync(join(spritesDir, entry)).isDirectory(),
    );
    const missing = packs.filter((pack) => {
      const files = readdirSync(join(spritesDir, pack));
      return !files.some((file) => /licen[cs]e/i.test(file)) && !assets().includes('docs/licences');
    });
    expect(missing).toStrictEqual([]);
  });

  it('records the source and the date each licence was read, for every entry', () => {
    // The manifest's own rule: "an asset whose licence text has not been read
    // does not get committed". A row with an empty licence column would pass
    // every check above.
    const rows = assets()
      .split('\n')
      .filter((line) => line.startsWith('|') && /\bhttps?:|authored in this repo/i.test(line));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      expect(cells.filter((cell) => cell.length > 0).length).toBeGreaterThanOrEqual(4);
      expect(row).toMatch(/20\d\d-\d\d-\d\d/);
    }
  });

  it('records the hero font, which is authored here rather than sourced', () => {
    expect(assets()).toMatch(/hero.*font|font.*hero/i);
  });
});
