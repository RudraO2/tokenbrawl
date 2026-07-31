import type { Observation } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { createDeployment } from '../../core/src/deployment';
import { assemblePrompt } from '../../core/src/scaffold';
import { createGroqClient } from './groq';

/**
 * The one test in this package that touches the network. Opt-in, and skipped by
 * default, so `npm test` stays hermetic and needs no key.
 *
 *   TOKENBRAWL_LIVE_GROQ=1 GROQ_API_KEY=... npx vitest run --root packages/providers src/groq-live.test.ts
 *
 * It exists for two reasons a fixture cannot serve. First, the recorded body in
 * `groq.test.ts` is only worth what its accuracy is worth, and this is what
 * re-verifies it. Second, Story 3.1 logged that `parseAction` is strict by
 * design and had never been measured against a real model -- if a well-formed
 * reply is being scored as a Parse Failure, that must be found here and fixed
 * by widening the grammar for every Deployment at once, never per Deployment.
 */

const LIVE = process.env.TOKENBRAWL_LIVE_GROQ === '1';
const API_KEY = process.env.GROQ_API_KEY ?? '';
const MODEL = process.env.TOKENBRAWL_LIVE_GROQ_MODEL ?? 'llama-3.1-8b-instant';

const OBSERVATION: Observation = {
  state: 'separation=140 yourHealth=100 theirHealth=88 yourMeter=40 theirCommitmentRemaining=6',
  legalActions: ['advance', 'retreat', 'attack', 'block'],
  tick: 12,
};

describe.skipIf(!LIVE || API_KEY.trim().length === 0)('live Groq smoke (opt-in)', () => {
  it('plays one real Decision Point and reports usage', async () => {
    const client = createGroqClient({ apiKey: API_KEY, model: MODEL });
    const deployment = createDeployment({ client });

    const prompt = deployment.observe(OBSERVATION, 25_000, false);
    const decision = await deployment.decide(prompt);

    // The reply parsed into a legal Action -- the parse-failure check 3.1 asked
    // for. A failure here is a finding about the grammar, not about the model.
    expect(OBSERVATION.legalActions).toContain(decision.action);

    // Usage was reported, which is what the Token Bank meters (INV-4).
    expect(decision.tokensSpent).not.toBeNull();
    expect(decision.tokensSpent).toBeGreaterThan(0);

    // Identity is recorded for this call (INV-6).
    expect(decision.provider).toBe('groq');
    expect(decision.endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(decision.rawResponse.length).toBeGreaterThan(0);
  }, 60_000);

  it('caps the reply at max_tokens=8 in Reflex Mode and still parses (INV-4)', async () => {
    const client = createGroqClient({ apiKey: API_KEY, model: MODEL });
    const deployment = createDeployment({ client });

    const prompt = deployment.observe(OBSERVATION, 0, true);
    const decision = await deployment.decide(prompt);

    expect(prompt.reflexMode).toBe(true);
    expect(OBSERVATION.legalActions).toContain(decision.action);
    expect(decision.tokensSpent).not.toBeNull();
    // The cap is 8; a reply that needed more would have been truncated.
    expect(decision.tokensSpent).toBeLessThanOrEqual(8);
  }, 60_000);
});
