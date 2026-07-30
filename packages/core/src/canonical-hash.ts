import { createHash } from 'node:crypto';

/**
 * Canonical, sorted-key, integers-only JSON serialisation -- the single
 * shared primitive `computeMatchId` and `computeConfigHash` both route
 * through (AD-8), so no two call sites can silently diverge on key order or
 * float handling. Mirrors the sorted-key discipline `mock-environment.ts`'s
 * `canonicalize()` already uses for state hashing (INV-2), generalised to
 * arbitrary JSON-shaped values instead of one fixed state shape.
 *
 * Throws on any non-integer number rather than rounding or truncating --
 * silently coercing a float would make two conceptually different configs
 * hash identically, which is worse than a loud failure at the call site.
 */
function canonicalize(value: unknown, seen: ReadonlySet<object>): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    // `Number.isSafeInteger`, not `Number.isInteger`: a value beyond
    // MAX_SAFE_INTEGER has already lost precision in the float64 it's stored
    // in, so two distinct large integers can silently coerce to the same
    // stored value before this function ever sees them.
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonicalStringify: non-integer or unsafe-integer number is not hashable: ${value}`);
    }
    return JSON.stringify(value);
  }

  if (typeof value !== 'object') {
    throw new Error(`canonicalStringify: unsupported value type: ${typeof value}`);
  }

  if (seen.has(value)) {
    throw new Error('canonicalStringify: circular reference is not hashable');
  }
  const nextSeen = new Set(seen).add(value);

  if (Array.isArray(value)) {
    // `Array.from`, not `.map` directly: `.map` skips holes in a sparse
    // array (e.g. `[1, , 3]`) rather than visiting them, so a hole would
    // silently vanish from the canonical output instead of hitting the
    // `undefined`-rejecting branch below.
    return `[${Array.from(value, (item) => canonicalize(item, nextSeen)).join(',')}]`;
  }

  // Only plain objects (object literals) are hashable. A `Date`, `Map`,
  // `Set`, or class instance with no *own enumerable* properties would
  // otherwise serialise to the indistinguishable `"{}"` regardless of its
  // actual content, letting two conceptually different values hash equal.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`canonicalStringify: non-plain object is not hashable: ${value?.constructor?.name ?? typeof value}`);
  }

  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], nextSeen)}`);
  return `{${entries.join(',')}}`;
}

export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new Set());
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
