import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCREENS } from './screens';

/**
 * Story 12.4: the layout rules that made the page stop scrolling sideways.
 *
 * The real check is `scripts/visual-gate.mjs`'s `no-horizontal-overflow`, which
 * measures a browser at 390x844 -- no stylesheet assertion can do that. These
 * cases exist for the reason every discipline rule in this repo is checked
 * twice: the gate needs Chrome and a dev server, this needs neither, and the
 * three rules below are each one deletion away from putting a 992px canvas back
 * inside a 390px viewport.
 *
 * The defect they pin, measured on 2026-08-10: `scrollWidth` 992 against a
 * `clientWidth` of 390, with `.tb-spectate-canvas` at 960 (it had no rule at
 * all) and `.tb-tagline` running to 409px in a masthead that could not wrap.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = readFileSync(join(HERE, '..', 'styles', 'app.css'), 'utf8');
const INDEX_HTML = readFileSync(join(HERE, '..', '..', 'index.html'), 'utf8');

/** The body of one rule, by selector. `null` when the selector is not declared at all. */
function ruleBody(css: string, selector: string): string | null {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) {
    return null;
  }
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return close < 0 ? null : css.slice(open + 1, close);
}

describe('every canvas box scales to its viewport (Story 12.4)', () => {
  // Each of these wraps a canvas whose backbuffer is a fixed 960x400 -- playback
  // is resolution-independent by design and every renderer assertion depends on
  // that width, so the element scales and the backbuffer does not.
  for (const selector of ['.tb-canvas', '.tb-arcade-canvas', '.tb-spectate-canvas']) {
    it(`gives ${selector} a fluid width and an auto height`, () => {
      const body = ruleBody(APP_CSS, selector);
      expect(body, `${selector} has no rule, so it lays out at its 960px backbuffer`).not.toBeNull();
      expect(body).toMatch(/width:\s*100%/);
      expect(body).toMatch(/height:\s*auto/);
    });
  }

  it('lets the masthead wrap, so the tagline cannot force the document wider', () => {
    // A flex item's minimum content size is its content: without `wrap` the
    // wordmark and the tagline share one line that simply overflows.
    expect(ruleBody(APP_CSS, '.tb-masthead')).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('the cabinet is wired end to end (Story 12.4)', () => {
  it('hides a screen with display, which is the only thing that zeroes its box', () => {
    // `visibility: hidden` and an off-screen transform both leave a laid-out
    // element, so both keep the overflow and the layout cost the story exists
    // to remove -- and the gate's `one-screen-at-a-time` measures the box.
    expect(APP_CSS).toMatch(/\[data-screen\]\s*\{\s*display:\s*none;/);
    expect(APP_CSS).toMatch(/\[data-screen\]\[data-screen-active\]\s*\{\s*display:\s*block;/);
  });

  it('marks every registered screen in index.html, so none is unreachable', () => {
    for (const screen of SCREENS) {
      const id = screen.selector.slice(1);
      // The id and the `data-screen` marker on the same tag: an id with no
      // marker is a section the router can show and the stylesheet never hides.
      expect(INDEX_HTML).toMatch(new RegExp(`id="${id}"[^>]*data-screen`));
    }
  });

  it('carries a host for the nav strip', () => {
    expect(INDEX_HTML).toContain('id="screen-nav"');
  });

  it('gives the nav link the focus ring docs/DESIGN.md requires', () => {
    // Every interactive control this story adds. `outline: none` anywhere is
    // already caught by `style-discipline.test.ts`; this is the positive half.
    expect(ruleBody(APP_CSS, '.tb-nav-link:focus-visible')).toMatch(
      /outline:\s*3px solid var\(--tb-accent\)/,
    );
  });
});
