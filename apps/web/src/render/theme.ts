import {
  PHASE_ACTIVE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
} from '../../../../packages/env-fighter/src/frames';

/**
 * The canvas half of the design system.
 *
 * `tokens.css` is the single source of every colour in the app, but a canvas
 * cannot cheaply read a CSS custom property -- `getComputedStyle` per frame is
 * a layout read sixty times a second, and it does not exist at all under the
 * `node` test environment. So the five colours are mirrored here, and
 * `style-discipline.test.ts` asserts that every value below still appears in
 * `tokens.css`. The mirror is machine-checked rather than assumed, which is
 * the only way two sources of one truth are survivable.
 *
 * This file and `tokens.css` are the ONLY places in `apps/web` where a hex
 * literal may appear. The same test enforces that too.
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
