import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIGHTER_CONFIG,
  assertIntegerConfig,
  canonicalStringify,
  createFighterEnvironment,
  mixSeed,
  nextRngState,
  sha256Hex,
} from './index';

describe('@tokenbrawl/env-fighter public surface', () => {
  it('exports the environment factory', () => {
    const env = createFighterEnvironment();
    expect(env.id).toBe('fighter-1v1');
    expect(typeof env.hash(env.reset(1))).toBe('string');
  });

  it('exports the frame-data config and its validator', () => {
    expect(DEFAULT_FIGHTER_CONFIG.ticksPerDecision).toBe(30);
    expect(() => assertIntegerConfig(DEFAULT_FIGHTER_CONFIG)).not.toThrow();
  });

  it('exports the hashing primitives the replay player will need', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Hex('')).toHaveLength(64);
  });

  it('exports the PRNG helpers as pure functions', () => {
    expect(mixSeed(0)).not.toBe(0);
    expect(nextRngState(1)).toBe(nextRngState(1));
  });
});
