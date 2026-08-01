import { describe, expect, it } from 'vitest';
import {
  REASONING_SIDECAR_VERSION,
  createReasoningSource,
  validateReasoningSidecar,
  type ReasoningSidecar,
} from './sidecar';
import { splitReasoning } from '../testing/sidecar-split';
import { buildDemoLog } from '../testing/demo-log';

/**
 * Story 4.2, AC3 and AC4.
 *
 * The sidecar is the mechanism AD-10 names: reasoning is sheddable payload and
 * playback never blocks on it. Two things have to be true for that to be worth
 * anything, and both are asserted here.
 *
 * 1. The split is lossless and the binding is enforced. A sidecar that lost a
 *    Decision Point shows a blank panel; a sidecar from another Match shows one
 *    Deployment's deliberation under another's name, which is worse.
 * 2. `loading` is a state the reader can be *in* and report, distinct from
 *    "recorded nothing" and from "will not arrive". AC4 is exactly that
 *    distinction, and collapsing it is how a slow network gets displayed to a
 *    visitor as a silent model.
 */

const MATCH_ID = 'a'.repeat(64);

function sidecar(overrides: Partial<ReasoningSidecar> = {}): unknown {
  return {
    schemaVersion: REASONING_SIDECAR_VERSION,
    matchId: MATCH_ID,
    entries: [
      { tick: 0, agentIndex: 0, reasoning: 'close the gap', rawResponse: 'ACTION: advance', reflexMode: false, parseFailure: false },
      { tick: 0, agentIndex: 1, reasoning: null, rawResponse: null, reflexMode: true, parseFailure: false },
    ],
    ...overrides,
  };
}

describe('validateReasoningSidecar', () => {
  it('accepts a well-formed document and freezes it', () => {
    const accepted = validateReasoningSidecar(sidecar(), MATCH_ID);
    expect(accepted.entries).toHaveLength(2);
    expect(accepted.entries[0].reasoning).toBe('close the gap');
    expect(accepted.entries[1].reflexMode).toBe(true);
  });

  it('checks the version before it reads any other field (AD-3)', () => {
    // The other fields are deliberately garbage: if the version check ran
    // second, one of *their* errors would be raised instead, and the document
    // would have been partially interpreted before being rejected.
    expect(() =>
      validateReasoningSidecar(
        { schemaVersion: '2.0.0', matchId: 42, entries: 'not an array' },
        MATCH_ID,
      ),
    ).toThrow(/unsupported schemaVersion 2\.0\.0/i);
  });

  it('refuses a sidecar belonging to another Match', () => {
    // The failure this prevents is not a crash. It is a page that renders
    // perfectly while attributing one model's reasoning to another.
    expect(() => validateReasoningSidecar(sidecar({ matchId: 'b'.repeat(64) }), MATCH_ID)).toThrow(
      /belongs to Match b{64}/,
    );
  });

  it('refuses two records for one Decision Point', () => {
    const duplicated = sidecar({
      entries: [
        { tick: 0, agentIndex: 0, reasoning: 'first', rawResponse: null, reflexMode: false, parseFailure: false },
        { tick: 0, agentIndex: 0, reasoning: 'second', rawResponse: null, reflexMode: false, parseFailure: false },
      ],
    });
    expect(() => validateReasoningSidecar(duplicated, MATCH_ID)).toThrow(/duplicate entry/);
  });

  it.each([
    ['a non-object', 'nope'],
    ['a missing matchId', sidecar({ matchId: undefined })],
    ['entries that are not an array', sidecar({ entries: undefined })],
  ])('refuses %s', (_label, candidate) => {
    expect(() => validateReasoningSidecar(candidate, MATCH_ID)).toThrow();
  });

  it.each([
    ['tick', { tick: -1 }],
    ['tick', { tick: 1.5 }],
    ['agentIndex', { agentIndex: 2 }],
    ['reasoning', { reasoning: 7 }],
    ['rawResponse', { rawResponse: {} }],
    ['reflexMode', { reflexMode: 'yes' }],
    ['parseFailure', { parseFailure: null }],
  ])('refuses an entry with a bad %s', (_field, patch) => {
    const bad = sidecar({
      entries: [
        {
          tick: 0,
          agentIndex: 0,
          reasoning: null,
          rawResponse: null,
          reflexMode: false,
          parseFailure: false,
          ...patch,
        },
      ] as ReasoningSidecar['entries'],
    });
    expect(() => validateReasoningSidecar(bad, MATCH_ID)).toThrow();
  });
});

describe('the reasoning source, as a four-state reader (AC4)', () => {
  const withSidecar = {
    reasoningSidecar: 'demo.reasoning.json',
    decisions: [
      { tick: 0, agentIndex: 0 as const },
      { tick: 0, agentIndex: 1 as const },
    ],
  };

  it('starts loading the moment the film exists, before any fetch is issued', () => {
    // The ordering matters: a visitor who hovers in the first hundred
    // milliseconds must get a loading state, not a source that has not yet
    // been told what it is.
    const source = createReasoningSource(withSidecar);
    expect(source.status()).toBe('loading');
    expect(source.at(0, 0).status).toBe('loading');
    expect(source.reason()).toBeNull();
  });

  it('is inline, never loading, for a log that carries its own reasoning', () => {
    const source = createReasoningSource({
      decisions: [{ tick: 0, agentIndex: 0, reasoning: 'hold the line' }],
    });
    expect(source.status()).toBe('inline');
    expect(source.at(0, 0)).toMatchObject({ found: true, reasoning: 'hold the line' });
  });

  it('treats an empty sidecar path as no sidecar at all', () => {
    expect(createReasoningSource({ reasoningSidecar: '', decisions: [] }).status()).toBe('inline');
    expect(createReasoningSource({ reasoningSidecar: null, decisions: [] }).status()).toBe('inline');
  });

  it('serves the sidecar once adopted', () => {
    const source = createReasoningSource(withSidecar);
    source.adopt(validateReasoningSidecar(sidecar(), MATCH_ID));

    expect(source.status()).toBe('ready');
    expect(source.at(0, 0)).toMatchObject({ found: true, reasoning: 'close the gap' });
    expect(source.at(0, 1)).toMatchObject({ found: true, reflexMode: true, reasoning: null });
  });

  it('goes unavailable with a reason rather than waiting forever', () => {
    const source = createReasoningSource(withSidecar);
    source.markUnavailable('HTTP 404');

    expect(source.status()).toBe('unavailable');
    expect(source.reason()).toBe('HTTP 404');
    // Not `loading`. That is the whole point: a visitor can tell a failure from
    // a slow network, and neither is displayed as an absent model.
    expect(source.at(0, 0).status).toBe('unavailable');
  });

  it('stops serving a stale map when it goes unavailable', () => {
    const source = createReasoningSource(withSidecar);
    source.adopt(validateReasoningSidecar(sidecar(), MATCH_ID));
    source.markUnavailable('connection lost');

    expect(source.at(0, 0).reasoning).toBeNull();
  });

  it('reports a Decision Point nobody logged as not found, without throwing', () => {
    const source = createReasoningSource(withSidecar);
    expect(source.at(9_999, 1)).toMatchObject({ found: false, reasoning: null });
  });

  it('keeps a parse failure readable while the sidecar is still in flight', () => {
    // `rawResponse` stays on the entry for a parse failure (the frozen schema's
    // `allOf` requires it), so the one case a visitor most needs to audit is
    // the one case that does not wait for the network.
    const source = createReasoningSource({
      reasoningSidecar: 'demo.reasoning.json',
      decisions: [
        { tick: 0, agentIndex: 0, parseFailure: true, rawResponse: 'I think I will advance!' },
      ],
    });

    expect(source.status()).toBe('loading');
    expect(source.at(0, 0)).toMatchObject({
      found: true,
      parseFailure: true,
      rawResponse: 'I think I will advance!',
    });
  });

  it('keeps two logs independent', () => {
    const a = createReasoningSource(withSidecar);
    const b = createReasoningSource(withSidecar);
    a.markUnavailable('gone');
    expect(b.status()).toBe('loading');
  });
});

describe('splitting a real Match (AC3)', () => {
  it('moves reasoning out of the document playback blocks on, losslessly', async () => {
    const original = await buildDemoLog();
    const { log, sidecar: split } = splitReasoning(original);

    expect(log.reasoningSidecar).toBe('demo.reasoning.json');
    expect(log.decisions).toHaveLength(original.decisions.length);
    expect(split.entries).toHaveLength(original.decisions.length);
    expect(split.matchId).toBe(original.matchId);

    for (const [index, entry] of split.entries.entries()) {
      const before = original.decisions[index];
      expect(entry.tick).toBe(before.tick);
      expect(entry.agentIndex).toBe(before.agentIndex);
      expect(entry.reasoning).toBe(before.reasoning ?? null);
      expect(entry.rawResponse).toBe(before.rawResponse ?? null);
      expect(log.decisions[index].reasoning).toBeUndefined();
    }

    // Smaller, and by enough to be worth the second request.
    expect(JSON.stringify(log).length).toBeLessThan(JSON.stringify(original).length);
  });

  it('leaves rawResponse on a parse failure, because the frozen schema requires it', () => {
    // Story 1.6: a parse failure is never retried and always recorded. Moving
    // its evidence into a sheddable file would make it unauditable, and the
    // schema's `allOf` rejects the document outright.
    const { log, sidecar: split } = splitReasoning({
      schemaVersion: '1.0.0',
      matchId: MATCH_ID,
      environment: { id: 'fighter-1v1', version: '1.0.0' },
      seed: 1,
      configHash: 'c'.repeat(64),
      agents: [
        { id: 'a', kind: 'bot' },
        { id: 'b', kind: 'bot' },
      ],
      decisions: [
        { tick: 0, agentIndex: 0, action: 'stand', parseFailure: true, rawResponse: 'ummm', reasoning: 'long deliberation' },
        { tick: 0, agentIndex: 1, action: 'advance', rawResponse: 'ACTION: advance', reasoning: 'close in' },
      ],
      result: { outcome: 'draw', endTick: 1, endReason: 'timeout', healthRemaining: [1, 1] },
      finalStateHash: 'd'.repeat(64),
    });

    expect(log.decisions[0].rawResponse).toBe('ummm');
    expect(log.decisions[0].reasoning).toBeUndefined();
    expect(log.decisions[1].rawResponse).toBeUndefined();
    // The sidecar still carries both, so the reader has one uniform shape.
    expect(split.entries[0]).toMatchObject({ rawResponse: 'ummm', reasoning: 'long deliberation' });
  });

  it('takes a large reasoning payload off the document playback blocks on (AC3)', async () => {
    // The AC names the case explicitly: "a Command Log whose reasoning payload
    // is large". A Deployment log carries a paragraph per Decision Point, so
    // the field that grows without bound is the one the fight must not wait
    // for. 2 KB per entry over 60 entries is a realistic Epic 3 log.
    const original = await buildDemoLog();
    const verbose = {
      ...original,
      decisions: original.decisions.map((entry) => ({
        ...entry,
        reasoning: 'x'.repeat(2_048),
      })),
    };

    const { log, sidecar: split } = splitReasoning(verbose);

    const before = JSON.stringify(verbose).length;
    const after = JSON.stringify(log).length;
    expect(before - after).toBeGreaterThan(2_048 * original.decisions.length);
    // And it really is smaller than the log we started this story with, not
    // merely smaller than the inflated one.
    expect(after).toBeLessThan(JSON.stringify(original).length);
    expect(split.entries.every((entry) => entry.reasoning?.length === 2_048)).toBe(true);
  });

  it('round-trips through the reader for every Decision Point', async () => {
    const { log, sidecar: split } = splitReasoning(await buildDemoLog());
    const source = createReasoningSource(log);
    source.adopt(validateReasoningSidecar(JSON.parse(JSON.stringify(split)), log.matchId));

    for (const entry of split.entries) {
      expect(source.at(entry.tick, entry.agentIndex)).toMatchObject({
        found: true,
        reasoning: entry.reasoning,
        rawResponse: entry.rawResponse,
      });
    }
  });
});
