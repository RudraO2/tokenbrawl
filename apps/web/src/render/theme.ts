import {
  PHASE_ACTIVE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
} from '../../../../packages/env-fighter/src/frames';

/**
 * The canvas half of the design system.
 *
 * `tokens.css` is the single source of every colour the *page* uses, but a
 * canvas cannot cheaply read a CSS custom property -- `getComputedStyle` per frame is
 * a layout read sixty times a second, and it does not exist at all under the
 * `node` test environment. So the five colours are mirrored here, and
 * `style-discipline.test.ts` asserts that every value below still appears in
 * `tokens.css`. The mirror is machine-checked rather than assumed, which is
 * the only way two sources of one truth are survivable.
 *
 * This file holds the **brand**, and it is not the only palette any more.
 * Story 11.1 split the app into two regimes: page chrome, which uses these
 * five colours and nothing else, and the arena under `render/`, whose health
 * tiers, super meter and per-fighter auras are not brand colours at all and
 * live in `render/arena-palette.ts`. Those three files -- `tokens.css`, this
 * one, and the arena palette -- are the only places in `apps/web/src` where a
 * hex literal may appear, and `style-discipline.test.ts` enforces that. See
 * `docs/DESIGN.md`, "Two regimes: the page and the arena".
 */

export interface Theme {
  readonly bg: string;
  readonly ink: string;
  readonly accent: string;
  readonly warn: string;
  readonly muted: string;
  /** Neubrutalism is mostly these two numbers. Both match `tokens.css`. */
  readonly borderWidth: number;
  readonly shadowOffset: number;
  readonly displayFont: string;
  readonly monoFont: string;
  /**
   * The HUD callout face (Story 11.3), and the reason it is not a third family.
   *
   * `docs/DESIGN.md`'s fourth audited rule -- *the two chosen faces and no
   * third family* -- was deliberately **kept** by Story 11.1 and deferred to
   * this story, with two priced routes offered: render arcade type from a
   * glyph table the way `hero/font.ts` does, or add a third `@font-face` and
   * amend the rule and `docs/ASSETS.md` in the same change.
   *
   * 11.3 took neither, because it turned out to need neither. What an arcade
   * callout actually needs is *weight and a hard offset shadow* at HUD size,
   * and the display face is already 800-weight Bricolage Grotesque with an
   * `'Arial Black'` fallback -- the whole reason that face was chosen was its
   * width axis. So this is `displayFont` at 16px rather than 20px: the same
   * family, the same weight, the same fallback stack, one size step down so a
   * callout sits inside a 20px bar instead of over it. The offset shadow is
   * `hud.ts`'s `arcadeText`, drawn as two `fillText` calls, which is the same
   * hard-shadow rule the page applies to a panel.
   *
   * No `@font-face`, no new family, no `docs/ASSETS.md` entry, and nothing for
   * the rule to be amended about. `style-discipline.test.ts` checks the claim
   * rather than trusting it: every family named here must appear in
   * `tokens.css` or be a generic/system fallback, so an arcade face cannot
   * drift in through the canvas font shorthand -- which is the one place the
   * CSS-anchored two-faces rule cannot see.
   */
  readonly arcadeFont: string;
}

export const THEME: Theme = Object.freeze({
  bg: '#0a0a0a',
  ink: '#f5f5f0',
  accent: '#c8ff00',
  warn: '#ff3b30',
  muted: '#6e6e68',
  borderWidth: 4,
  shadowOffset: 6,
  displayFont: "800 20px 'Bricolage Grotesque', 'Arial Black', sans-serif",
  monoFont: "14px 'Departure Mono', ui-monospace, monospace",
  arcadeFont: "800 16px 'Bricolage Grotesque', 'Arial Black', sans-serif",
});

/**
 * Fill for a fighter in a given Commitment Window phase.
 *
 * The three phases must be visually distinct, because the whole point of the
 * frame data is that a viewer can see *why* a punish landed: startup is the
 * opponent's window to walk out of range, active is the moment it connects,
 * recovery is when it is helpless. Rendering them alike would hide the one
 * mechanic Story 2.2 exists to make legible.
 *
 * Idle -- and anything unrecognised -- is ink. Falling back to the neutral
 * colour rather than throwing means a phase code added by a later story
 * renders as a plain fighter instead of blanking the canvas mid-playback.
 */
export function phaseFill(theme: Theme, phase: number): string {
  if (phase === PHASE_ACTIVE) {
    return theme.accent;
  }
  if (phase === PHASE_STARTUP) {
    return theme.warn;
  }
  if (phase === PHASE_RECOVERY) {
    return theme.muted;
  }
  return theme.ink;
}
