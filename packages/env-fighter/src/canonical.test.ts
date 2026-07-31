import { describe, expect, it } from 'vitest';
import { canonicalStringify } from './canonical';

describe('canonicalStringify', () => {
  it('sorts object keys, so declaration order cannot change a hash', () => {
    expect(canonicalStringify({ tick: 30, health: [10, 20] })).toBe(
      canonicalStringify({ health: [10, 20], tick: 30 }),
    );
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    expect(canonicalStringify({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order, which is positional not nominal', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('includes a newly added field automatically', () => {
    // The regression this guards: a hand-listed canonicaliser silently drops
    // a field Story 2.2 adds to FighterState, and no test goes red.
    const before = canonicalStringify({ meter: [0, 0], tick: 0 });
    const after = canonicalStringify({ meter: [0, 0], phase: 2, tick: 0 });
    expect(after).not.toBe(before);
    expect(after).toContain('"phase":2');
  });

  it('rejects a non-integer number rather than rounding it', () => {
    const oneThird = 1 / 3;
    expect(() => canonicalStringify({ health: oneThird })).toThrow(/non-integer/);
  });

  it('rejects an unsafe integer, which has already lost precision', () => {
    expect(() => canonicalStringify(Number.MAX_SAFE_INTEGER + 2)).toThrow(/unsafe-integer/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(/non-integer/);
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(/non-integer/);
  });

  it('accepts negative and zero integers', () => {
    expect(canonicalStringify({ delta: -5, zero: 0 })).toBe('{"delta":-5,"zero":0}');
  });

  it('rejects undefined, functions and symbols', () => {
    expect(() => canonicalStringify(undefined)).toThrow(/unsupported value type/);
    expect(() => canonicalStringify({ fn: () => 1 })).toThrow(/unsupported value type/);
    expect(() => canonicalStringify({ sym: Symbol('x') })).toThrow(/unsupported value type/);
  });

  it('rejects a sparse array hole instead of skipping it', () => {
    const sparse = [1, , 3] as unknown[];
    expect(() => canonicalStringify(sparse)).toThrow(/unsupported value type/);
  });

  it('rejects a non-plain object that would serialise as an empty object', () => {
    expect(() => canonicalStringify({ when: new Map() })).toThrow(/non-plain object/);
    expect(() => canonicalStringify({ set: new Set([1]) })).toThrow(/non-plain object/);
  });

  it('rejects a circular reference', () => {
    const cyclic: Record<string, unknown> = { tick: 0 };
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(/circular reference/);
  });

  it('accepts a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.tick = 1;
    expect(canonicalStringify(bare)).toBe('{"tick":1}');
  });

  it('serialises null and booleans', () => {
    expect(canonicalStringify({ flag: true, nothing: null })).toBe('{"flag":true,"nothing":null}');
  });

  it('escapes strings the same way JSON does', () => {
    expect(canonicalStringify({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
  });

  it('does not treat repeated sibling references as circular', () => {
    const shared = { tick: 1 };
    expect(canonicalStringify({ left: shared, right: shared })).toBe(
      '{"left":{"tick":1},"right":{"tick":1}}',
    );
  });
});
