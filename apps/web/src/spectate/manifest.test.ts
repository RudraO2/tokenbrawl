import { describe, expect, it } from 'vitest';
import {
  fetchSpectateManifest,
  offsetForNow,
  validateSpectateManifest,
  SPECTATE_MANIFEST_URL,
  type SpectateManifest,
} from './manifest';

/** A three-entry manifest of 100, 200 and 300 frames -- 600 total, at a made-up but fixed anchor. */
function threeEntryManifest(): SpectateManifest {
  return validateSpectateManifest({
    schemaVersion: '1.0.0',
    loopStartEpochMs: 1_000_000,
    totalLoopDurationMs: 10_000, // 600 frames over 10s -> 60fps, 1000ms per 60 frames
    entries: [
      { id: 'a', commandLogUrl: '/replays/a.command-log.json', schemaVersion: '1.0.0', frameCount: 100 },
      { id: 'b', commandLogUrl: '/replays/b.command-log.json', schemaVersion: '1.0.0', frameCount: 200 },
      { id: 'c', commandLogUrl: '/replays/c.command-log.json', schemaVersion: '1.0.0', frameCount: 300 },
    ],
  });
}

describe('validateSpectateManifest', () => {
  it('accepts a well-formed document', () => {
    const manifest = threeEntryManifest();
    expect(manifest.entries).toHaveLength(3);
  });

  it('rejects a document with no entries', () => {
    expect(() =>
      validateSpectateManifest({
        schemaVersion: '1.0.0',
        loopStartEpochMs: 0,
        totalLoopDurationMs: 0,
        entries: [],
      }),
    ).toThrow(/at least one entry/);
  });

  it('rejects a non-object document', () => {
    expect(() => validateSpectateManifest('not json')).toThrow(/must be an object/);
  });

  it('rejects an entry missing a required field', () => {
    expect(() =>
      validateSpectateManifest({
        schemaVersion: '1.0.0',
        loopStartEpochMs: 0,
        totalLoopDurationMs: 1000,
        entries: [{ id: 'a' }],
      }),
    ).toThrow(/commandLogUrl/);
  });

  it('accepts an optional reasoningUrl and rejects an empty one', () => {
    const withUrl = validateSpectateManifest({
      schemaVersion: '1.0.0',
      loopStartEpochMs: 0,
      totalLoopDurationMs: 1000,
      entries: [
        {
          id: 'a',
          commandLogUrl: '/x.json',
          reasoningUrl: '/x.reasoning.json',
          schemaVersion: '1.0.0',
          frameCount: 10,
        },
      ],
    });
    expect(withUrl.entries[0].reasoningUrl).toBe('/x.reasoning.json');

    expect(() =>
      validateSpectateManifest({
        schemaVersion: '1.0.0',
        loopStartEpochMs: 0,
        totalLoopDurationMs: 1000,
        entries: [{ id: 'a', commandLogUrl: '/x.json', reasoningUrl: '  ', schemaVersion: '1.0.0', frameCount: 10 }],
      }),
    ).toThrow(/reasoningUrl/);
  });
});

describe('fetchSpectateManifest', () => {
  it('fetches the fixed manifest URL and validates the result', async () => {
    const manifest = threeEntryManifest();
    const calls: string[] = [];
    const result = await fetchSpectateManifest(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => manifest };
    });
    expect(calls).toStrictEqual([SPECTATE_MANIFEST_URL]);
    expect(result.entries).toHaveLength(3);
  });

  it('throws on a non-ok response rather than validating garbage', async () => {
    await expect(
      fetchSpectateManifest(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('offsetForNow: the one wall-clock read, isolated and pure (AD-17, INV-3)', () => {
  it('lands at the very start when now equals the loop-start epoch', () => {
    const manifest = threeEntryManifest();
    expect(offsetForNow(manifest, manifest.loopStartEpochMs)).toStrictEqual({
      entryIndex: 0,
      frameOffset: 0,
    });
  });

  it('joins mid-first-entry partway through', () => {
    const manifest = threeEntryManifest();
    // 100 frames over the first (100/600)*10000 = 1666.67ms. Halfway through
    // entry "a" is at ~833ms, i.e. frame ~50.
    const now = manifest.loopStartEpochMs + 833;
    const offset = offsetForNow(manifest, now);
    expect(offset.entryIndex).toBe(0);
    expect(offset.frameOffset).toBeGreaterThan(30);
    expect(offset.frameOffset).toBeLessThan(70);
  });

  it('joins mid-second-entry once past the first entry boundary', () => {
    const manifest = threeEntryManifest();
    // Entry "a" spans frames [0,100) -> ms [0, 1666.67). Entry "b" spans
    // frames [100,300) -> ms [1666.67, 5000). Pick the midpoint of "b".
    const now = manifest.loopStartEpochMs + 3_333;
    const offset = offsetForNow(manifest, now);
    expect(offset.entryIndex).toBe(1);
    expect(offset.frameOffset).toBeGreaterThanOrEqual(0);
    expect(offset.frameOffset).toBeLessThan(200);
  });

  it('joins mid-last-entry near the end of the loop', () => {
    const manifest = threeEntryManifest();
    const now = manifest.loopStartEpochMs + 9_500;
    const offset = offsetForNow(manifest, now);
    expect(offset.entryIndex).toBe(2);
    expect(offset.frameOffset).toBeGreaterThanOrEqual(0);
    expect(offset.frameOffset).toBeLessThan(300);
  });

  it('wraps to the start of the loop once a full cycle has elapsed', () => {
    const manifest = threeEntryManifest();
    const oneCycleLater = manifest.loopStartEpochMs + manifest.totalLoopDurationMs;
    expect(offsetForNow(manifest, oneCycleLater)).toStrictEqual(offsetForNow(manifest, manifest.loopStartEpochMs));
  });

  it('wraps correctly across many cycles', () => {
    const manifest = threeEntryManifest();
    const now = manifest.loopStartEpochMs + manifest.totalLoopDurationMs * 7 + 833;
    const direct = manifest.loopStartEpochMs + 833;
    expect(offsetForNow(manifest, now)).toStrictEqual(offsetForNow(manifest, direct));
  });

  it('handles a "now" before the anchor without crashing, folding it into the cycle', () => {
    const manifest = threeEntryManifest();
    const before = manifest.loopStartEpochMs - 833;
    const offset = offsetForNow(manifest, before);
    expect(offset.entryIndex).toBe(2);
  });

  it('always returns entry zero, frame zero for a single-entry manifest', () => {
    const manifest = validateSpectateManifest({
      schemaVersion: '1.0.0',
      loopStartEpochMs: 500,
      totalLoopDurationMs: 2000,
      entries: [{ id: 'only', commandLogUrl: '/only.json', schemaVersion: '1.0.0', frameCount: 120 }],
    });

    expect(offsetForNow(manifest, 500).entryIndex).toBe(0);
    expect(offsetForNow(manifest, 1_500).entryIndex).toBe(0);
    expect(offsetForNow(manifest, 999_999_999).entryIndex).toBe(0);
    expect(offsetForNow(manifest, 999_999_999).frameOffset).toBeLessThan(120);
  });

  it('never returns a frameOffset past the entry it is inside', () => {
    const manifest = threeEntryManifest();
    for (let step = 0; step < 20; step += 1) {
      const now = manifest.loopStartEpochMs + step * 617;
      const offset = offsetForNow(manifest, now);
      const frameCount = manifest.entries[offset.entryIndex].frameCount;
      expect(offset.frameOffset).toBeGreaterThanOrEqual(0);
      expect(offset.frameOffset).toBeLessThan(frameCount);
    }
  });

  it('is pure: the same inputs always produce the same output', () => {
    const manifest = threeEntryManifest();
    const a = offsetForNow(manifest, manifest.loopStartEpochMs + 4_242);
    const b = offsetForNow(manifest, manifest.loopStartEpochMs + 4_242);
    expect(a).toStrictEqual(b);
  });

  it('degrades to entry zero, frame zero when the manifest carries no frames at all', () => {
    const manifest = validateSpectateManifest({
      schemaVersion: '1.0.0',
      loopStartEpochMs: 0,
      totalLoopDurationMs: 0,
      entries: [{ id: 'empty', commandLogUrl: '/e.json', schemaVersion: '1.0.0', frameCount: 0 }],
    });
    expect(offsetForNow(manifest, 12_345)).toStrictEqual({ entryIndex: 0, frameOffset: 0 });
  });
});
