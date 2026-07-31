import type { ProviderId } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { runMeteringProbe } from './metering-probe';

/**
 * Opt-in live smoke for the Metering Probe, mirroring `groq-live.test.ts`.
 *
 *   TOKENBRAWL_LIVE_PROBE=1 TOKENBRAWL_LIVE_PROBE_PROVIDER=groq \
 *   TOKENBRAWL_LIVE_PROBE_MODEL=llama-3.1-8b-instant GROQ_API_KEY=... \
 *   npx vitest run --root packages/providers src/metering-probe-live.test.ts
 *
 * This is the only test that can tell you what a real provider actually does
 * with the combination the story is about. Every other case in
 * `metering-probe.test.ts` runs against a fixture, and a fixture cannot be
 * wrong about the provider in the way that matters here -- it can only be
 * wrong in the way whoever wrote it was.
 *
 * The result is deliberately not asserted to be `reports-reasoning`. Which
 * classification a given free-tier Deployment earns is the finding, not the
 * expectation; asserting one would turn an honest measurement into a test that
 * fails when the provider changes its mind, which is exactly the moment this
 * probe is supposed to be believed.
 */

const LIVE = process.env.TOKENBRAWL_LIVE_PROBE === '1';
const PROVIDER = (process.env.TOKENBRAWL_LIVE_PROBE_PROVIDER ?? 'groq') as ProviderId;
const MODEL = process.env.TOKENBRAWL_LIVE_PROBE_MODEL ?? 'llama-3.1-8b-instant';

const KEY_BY_PROVIDER: Readonly<Record<string, string | undefined>> = {
  groq: process.env.GROQ_API_KEY,
  cerebras: process.env.CEREBRAS_API_KEY,
  'google-ai-studio': process.env.GOOGLE_AI_STUDIO_API_KEY,
};

const API_KEY = KEY_BY_PROVIDER[PROVIDER] ?? '';

describe.skipIf(!LIVE || API_KEY.trim().length === 0)('live Metering Probe smoke (opt-in)', () => {
  it('classifies one real Deployment and reports what it saw', async () => {
    const outcome = await runMeteringProbe({ provider: PROVIDER, model: MODEL, apiKey: API_KEY });

    expect(['reports-reasoning', 'reports-completion-only', 'no-usage-reported']).toContain(
      outcome.result,
    );
    expect(outcome.provider).toBe(PROVIDER);
    expect(outcome.model).toBe(MODEL);

    // The classification is the observation; print it so a run that is doing
    // its job leaves a record rather than only a green tick.
    console.log(
      `Metering Probe: ${outcome.id} -> ${outcome.result} ` +
        `(tokensSpent=${String(outcome.usage.tokensSpent)}, deliberation=${String(outcome.usage.reasoningTokens)})`,
    );
  }, 120_000);
});
