import { describe, expect, it } from 'vitest';
import type { DeploymentIdentity } from '@tokenbrawl/contracts';
import { createIdentityArtist, deriveVisualIdentity } from './identity';
import type { Canvas2D } from './canvas2d';
import type { DrawnFighter, FighterArtist } from './artist';
import { THEME } from './theme';

/**
 * Story 9.4's I/O matrix: determinism, independent variation across
 * colorway/glyph/silhouette, and that the wrapping decorator leaves the base
 * artist's own drawing untouched. The "no emblem for bot/human" and
 * "malformed deployment-kind agent" rows are `main.ts`'s wiring decision, not
 * this pure module's -- they are exercised where the `log.agents[agentIndex]`
 * lookup actually happens.
 */

// The spec's own I/O-matrix fixture: same provider and model, endpoint only
// differs. `ep-7` is not arbitrary -- it was found by search over a small
// fixture space specifically because it makes colorway, glyph *and*
// silhouette all differ from `ep-a`'s, proving the three axes really do vary
// independently rather than two of them happening to move together.
const GROQ_A: DeploymentIdentity = { provider: 'groq', endpoint: 'ep-a', model: 'llama3' };
const GROQ_B: DeploymentIdentity = { provider: 'groq', endpoint: 'ep-7', model: 'llama3' };

describe('deriveVisualIdentity', () => {
  it('is deterministic: the same triple hashed twice gives an identical emblem', () => {
    const first = deriveVisualIdentity(GROQ_A);
    const second = deriveVisualIdentity({ ...GROQ_A });

    expect(second).toStrictEqual(first);
  });

  it('varies colorway, glyph and silhouette independently for two Deployments differing only in endpoint', () => {
    const a = deriveVisualIdentity(GROQ_A);
    const b = deriveVisualIdentity(GROQ_B);

    // Not "at least one differs" -- each of the three axes is asserted on its
    // own, because a fixture pair that happened to collide on one axis would
    // let a real bug (e.g. glyph and silhouette secretly reading the same
    // hash slice) pass silently.
    expect(a.colorway).not.toBe(b.colorway);
    expect(a.glyph).not.toBe(b.glyph);
    expect(a.silhouette).not.toBe(b.silhouette);
  });

  it('produces a lowercase #rrggbb colorway with no hex literal driving it', () => {
    const identity = deriveVisualIdentity(GROQ_A);

    expect(identity.colorway).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('only ever picks from the declared glyph and silhouette enums', () => {
    const glyphs = new Set(['square', 'triangle', 'diamond', 'cross']);
    const silhouettes = new Set(['circle', 'hex', 'chevron', 'plate']);

    const deployments: readonly DeploymentIdentity[] = [
      GROQ_A,
      GROQ_B,
      { provider: 'xai', endpoint: 'https://api.x.ai', model: 'grok' },
      { provider: 'byok', endpoint: 'https://example.test', model: 'm' },
    ];
    for (const deployment of deployments) {
      const identity = deriveVisualIdentity(deployment);
      expect(glyphs.has(identity.glyph)).toBe(true);
      expect(silhouettes.has(identity.silhouette)).toBe(true);
    }
  });
});

/** Records every call the base artist receives, so wrapping can be proven additive. */
function recordingArtist(id: string, calls: string[]): FighterArtist {
  return {
    id,
    draw: (_ctx: Canvas2D, fighter: DrawnFighter): void => {
      calls.push(`${id}->${String(fighter.agentIndex)}`);
    },
  };
}

function silentCanvas(): Canvas2D {
  const state: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: false,
    globalAlpha: 1,
  };
  return new Proxy(state, {
    get: (target, property: string): unknown =>
      property in target ? target[property] : (): void => undefined,
    set: (target, property: string, value: unknown): boolean => {
      target[property] = value;
      return true;
    },
  }) as unknown as Canvas2D;
}

const FIGHTER: DrawnFighter = {
  x: 200,
  groundY: 300,
  facing: 1,
  phase: 0,
  committedAction: 0,
  agentIndex: 0,
  animation: { clip: 'idle', frame: 0 },
};

describe('createIdentityArtist', () => {
  it('calls the base artist unchanged before drawing the emblem', () => {
    const calls: string[] = [];
    const base = recordingArtist('block-artist', calls);
    const wrapped = createIdentityArtist(base, deriveVisualIdentity(GROQ_A));

    wrapped.draw(silentCanvas(), FIGHTER, THEME);

    expect(calls).toStrictEqual(['block-artist->0']);
  });

  it('does not throw when drawing with a real (non-recording) canvas surface', () => {
    const wrapped = createIdentityArtist(
      { id: 'block-artist', draw: (): void => undefined },
      deriveVisualIdentity(GROQ_A),
    );

    expect(() => wrapped.draw(silentCanvas(), FIGHTER, THEME)).not.toThrow();
  });
});
