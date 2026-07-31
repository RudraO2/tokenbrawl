/**
 * Canonical, sorted-key, integers-only serialisation for this package.
 *
 * Mirrors `packages/core/src/canonical-hash.ts`'s discipline, but is a
 * separate implementation on purpose: core's module imports `node:crypto` at
 * the top level, and AD-4 forbids a Node built-in anywhere in this package's
 * graph. `canonical.test.ts` pins the two to the same observable behaviour.
 *
 * Key order comes from `Object.keys(value).sort()`, never a hand-written
 * literal. That matters because `FighterState` grows -- Story 2.2 adds
 * Commitment Window phases -- and a hand-listed canonicaliser silently drops
 * new fields out of the hash, which is exactly how INV-2 rots without any
 * test going red.
 */

function canonicalize(value: unknown, seen: ReadonlySet<object>): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    // `Number.isSafeInteger`, not `Number.isInteger`: past MAX_SAFE_INTEGER
    // two distinct integers can already have collapsed onto the same stored
    // value, so the hash would claim two different states are one.
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `canonicalStringify: non-integer or unsafe-integer number is not hashable: ${value}`,
      );
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
    // `Array.from`, not `.map`: `.map` skips holes in a sparse array rather
    // than visiting them, so a hole would vanish instead of hitting the
    // `undefined`-rejecting branch below.
    return `[${Array.from(value, (item) => canonicalize(item, nextSeen)).join(',')}]`;
  }

  // Only plain objects are hashable. A `Date`, `Map`, `Set`, or class
  // instance with no own enumerable properties would otherwise serialise to
  // an indistinguishable `"{}"` regardless of what it actually holds.
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `canonicalStringify: non-plain object is not hashable: ${value?.constructor?.name ?? typeof value}`,
    );
  }

  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], nextSeen)}`,
    );
  return `{${entries.join(',')}}`;
}

export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new Set());
}
