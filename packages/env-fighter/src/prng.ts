/**
 * The Match PRNG: xorshift32, integer-only, and deliberately *stateless* at
 * module scope. Both functions are pure over a single integer; the generator
 * itself lives on `FighterState.rngState` and is threaded forward by
 * `step()`'s return value.
 *
 * A module-level generator here is the leak that makes determinism tests pass
 * in-process and fail across processes -- see `docs/ARCHITECTURE.md`,
 * "Determinism, concretely".
 */

/** Knuth's golden-ratio multiplier, used to decorrelate small integer seeds. */
const SEED_MULTIPLIER = 0x9e3779b9;
/** Any non-zero state works; this one is the usual mulberry32 constant. */
const NON_ZERO_FALLBACK = 0x6d2b79f5;

/**
 * Turn a Match seed into an initial generator state.
 *
 * Mixing first matters: xorshift32 can never leave an all-zero state, so a
 * bare `(seed | 0) || 1` fallback would map seed 0 and seed 1 onto the same
 * stream. After `Math.imul` mixing only a genuine 32-bit collision could,
 * and the small integer seeds Matches use never collide.
 */
export function mixSeed(seed: number): number {
  const mixed = Math.imul(seed | 0, SEED_MULTIPLIER) | 0;
  return mixed === 0 ? NON_ZERO_FALLBACK : mixed;
}

/** One xorshift32 advance. Same input, same output, forever. */
export function nextRngState(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x | 0;
}
