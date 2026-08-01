import { describe, expect, it } from 'vitest';
import { validateCommandLog } from '../../../../packages/core/src/command-log';
import { isRatingEligible, ratingEligibility } from '../../../../packages/core/src/rating-eligibility';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { chatCompletionBody, createFakeTransport } from '../testing/byok-transport';
import { ByokKeyError } from './client';
import { runByokMatch } from './run';

/**
 * Story 4.6, end to end: a whole Match played in the tab, with no network.
 *
 * This is the file where the ACs meet each other. AC1 is asserted over every
 * request a *complete* Match made rather than over one call; AC2's "never
 * passed into `packages/core`" is asserted over the artefact core produced;
 * AC3's "no partially-recorded Match" is asserted by there being no log at all;
 * and AC4 is asserted by replaying the result through the same player the demo
 * uses.
 */

const P1_KEY = 'gsk_p1_key_do_not_use_000001';
const P2_KEY = 'csk_p2_key_do_not_use_000002';
const SEED = 4_601;

/** Both fighters answer with a legal Action, so the Match runs to a real terminal state. */
function fighters() {
  return [
    { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P1_KEY },
    { provider: 'cerebras', model: 'llama3.1-8b', apiKey: P2_KEY },
  ] as const;
}

const ACTIONS = ['advance', 'attack', 'retreat', 'block', 'special'] as const;

function rotatingTransport() {
  return createFakeTransport({
    // A rotation rather than one Action: a Match of nothing but `attack` spends
    // most of its Decision Points inside a Commitment Window, which would leave
    // the origin assertion covering a fraction of the calls it looks like it
    // covers.
    body: (call) => chatCompletionBody(`ACTION: ${ACTIONS[call % ACTIONS.length]}`),
  });
}

describe('a whole Match runs in the browser (AD-4)', () => {
  it('produces a Command Log the frozen schema accepts', async () => {
    const transport = rotatingTransport();
    const log = await runByokMatch({ fighters: fighters(), seed: SEED, fetch: transport.fetch });
    expect(() => validateCommandLog(log)).not.toThrow();
    expect(log.decisions.length).toBeGreaterThan(0);
    expect(transport.calls().length).toBeGreaterThan(0);
  });

  it('replays: the log the browser built verifies against its own final hash (AC4)', async () => {
    // The strongest available statement that this is a real Command Log and not
    // a plausible-looking document: re-simulating it from (seed, config,
    // actions) lands on the hash it recorded.
    const log = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    const film = buildReplayFilm(log, createFighterEnvironment());
    expect(film.matchesRecordedHash).toBe(true);
    expect(film.frames.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same seed and the same replies produce the same log', async () => {
    const first = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    const second = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    expect(second.finalStateHash).toBe(first.finalStateHash);
    expect(second.matchId).toBe(first.matchId);
  });

  it('reports progress as a count of calls, never as a duration (INV-3)', async () => {
    const progress: number[] = [];
    const transport = rotatingTransport();
    await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: transport.fetch,
      onCall: (calls) => progress.push(calls),
    });
    expect(progress).toStrictEqual(transport.calls().map((_call, index) => index + 1));
  });
});

describe('the keys reach one origin each and nothing else (AC1)', () => {
  it('contacts exactly the two selected providers across the whole Match', async () => {
    const transport = rotatingTransport();
    await runByokMatch({ fighters: fighters(), seed: SEED, fetch: transport.fetch });
    expect([...transport.origins()].sort()).toStrictEqual([
      'https://api.cerebras.ai',
      'https://api.groq.com',
    ]);
  });

  it('never puts one fighter\'s key on the other fighter\'s request', async () => {
    const transport = rotatingTransport();
    await runByokMatch({ fighters: fighters(), seed: SEED, fetch: transport.fetch });

    for (const call of transport.calls()) {
      const authorisation = call.headers.Authorization ?? '';
      if (call.url.includes('api.groq.com')) {
        expect(authorisation).toContain(P1_KEY);
        expect(authorisation).not.toContain(P2_KEY);
      } else {
        expect(authorisation).toContain(P2_KEY);
        expect(authorisation).not.toContain(P1_KEY);
      }
    }
  });

  it('sends both fighters to one provider when that is what was chosen, still one origin', async () => {
    const transport = rotatingTransport();
    await runByokMatch({
      fighters: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P1_KEY },
        { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P2_KEY },
      ],
      seed: SEED,
      fetch: transport.fetch,
    });
    expect(transport.origins()).toStrictEqual(['https://api.groq.com']);
    // Same provider, same model, two distinct Agents -- the log must still tell
    // the sides apart.
    expect(transport.calls().some((call) => (call.headers.Authorization ?? '').includes(P1_KEY))).toBe(true);
    expect(transport.calls().some((call) => (call.headers.Authorization ?? '').includes(P2_KEY))).toBe(true);
  });
});

describe('the keys never leave the tab, and never reach core (AC2)', () => {
  it('puts no key anywhere in the Command Log', async () => {
    const log = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    const serialised = JSON.stringify(log);
    expect(serialised).not.toContain(P1_KEY);
    expect(serialised).not.toContain(P2_KEY);
  });

  it('puts no key in any prompt core assembled', async () => {
    // The prompt is built by `assemblePrompt` in `packages/core` and arrives on
    // the wire as the request body. If a key were reaching core, this is where
    // it would surface -- and it is the only observable core produces.
    const transport = rotatingTransport();
    await runByokMatch({ fighters: fighters(), seed: SEED, fetch: transport.fetch });
    for (const call of transport.calls()) {
      expect(call.body).not.toContain(P1_KEY);
      expect(call.body).not.toContain(P2_KEY);
      expect(call.url).not.toContain(P1_KEY);
      expect(call.url).not.toContain(P2_KEY);
    }
  });
});

describe('a failed key produces no Match at all (AC3)', () => {
  it('rejects with the fighter named, and returns no log', async () => {
    // The 401 lands mid-Match, after several successful calls: the case the AC
    // is actually about is a Match that had already started.
    const transport = createFakeTransport({
      statuses: [200, 200, 200, 200, 401],
      body: (call) => (call < 4 ? chatCompletionBody('ACTION: advance') : 'Invalid API Key'),
    });
    const error = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: transport.fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).failure).toBe('invalid-key');
    expect((error as ByokKeyError).message).toMatch(/Fighter [12]/);
  });

  it('makes no request at all when a provider is CLI-only (AC5)', async () => {
    const transport = rotatingTransport();
    await expect(
      runByokMatch({
        fighters: [
          { provider: 'openrouter', model: 'anything', apiKey: P1_KEY },
          { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P2_KEY },
        ],
        seed: SEED,
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/cannot be run from a browser/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('makes no request at all when either key is blank', async () => {
    const transport = rotatingTransport();
    await expect(
      runByokMatch({
        fighters: [
          { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P1_KEY },
          { provider: 'cerebras', model: 'llama3.1-8b', apiKey: '' },
        ],
        seed: SEED,
        fetch: transport.fetch,
      }),
    ).rejects.toBeInstanceOf(ByokKeyError);
    // Fighter 1's key was valid and is not spent: both clients are built before
    // either is called.
    expect(transport.calls()).toHaveLength(0);
  });

  it('accepts both ends of the seed range the frozen schema allows', async () => {
    // Correct today and unpinned until now: the bounds are inclusive, and an
    // off-by-one in either direction would refuse a seed the schema accepts.
    for (const seed of [0, 4_294_967_295]) {
      const log = await runByokMatch({
        fighters: fighters(),
        seed,
        fetch: rotatingTransport().fetch,
      });
      expect(log.seed).toBe(seed);
      expect(() => validateCommandLog(log)).not.toThrow();
    }
  });

  it('refuses a seed the frozen schema could not carry, before any request', async () => {
    const transport = rotatingTransport();
    for (const seed of [-1, 1.5, 4_294_967_296, Number.NaN]) {
      await expect(
        runByokMatch({ fighters: fighters(), seed, fetch: transport.fetch }),
      ).rejects.toThrow(/whole number between 0 and 4294967295/);
    }
    expect(transport.calls()).toHaveLength(0);
  });
});

describe('the result is marked, and unratable (AC4, AD-11)', () => {
  it('records provider byok on both agents and on every decision', async () => {
    const log = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    expect(log.agents.map((agent) => agent.deployment?.provider)).toStrictEqual(['byok', 'byok']);
    expect([...new Set(log.decisions.map((entry) => entry.provider))]).toStrictEqual(['byok']);
  });

  it('keeps the upstream endpoint and model, so provenance survives (INV-6)', async () => {
    const log = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    expect(log.agents[0].deployment?.endpoint).toContain('api.groq.com');
    expect(log.agents[0].deployment?.model).toBe('llama-3.1-8b-instant');
    expect(log.agents[1].deployment?.endpoint).toContain('api.cerebras.ai');
    expect(log.agents[1].deployment?.model).toBe('llama3.1-8b');
  });

  it('is excluded from rating computation, with a stated reason', async () => {
    const log = await runByokMatch({
      fighters: fighters(),
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    expect(isRatingEligible(log)).toBe(false);
    expect(ratingEligibility(log).reason).toMatch(/AD-11/);
  });

  it('gives the two sides distinct ids even when they are the same model', async () => {
    const log = await runByokMatch({
      fighters: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P1_KEY },
        { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: P2_KEY },
      ],
      seed: SEED,
      fetch: rotatingTransport().fetch,
    });
    expect(log.agents[0].id).not.toBe(log.agents[1].id);
    expect(() => validateCommandLog(log)).not.toThrow();
  });
});
