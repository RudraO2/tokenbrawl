import type { Observation } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { createDeployment } from '../../core/src/deployment';
import { createGoogleClient } from './google';

/**
 * Opt-in live smoke, mirroring `groq-live.test.ts`.
 *
 *   TOKENBRAWL_LIVE_GOOGLE=1 GOOGLE_AI_STUDIO_API_KEY=... npx vitest run --root packages/providers src/google-live.test.ts
 */

const LIVE = process.env.TOKENBRAWL_LIVE_GOOGLE === '1';
const API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY ?? '';
const MODEL = process.env.TOKENBRAWL_LIVE_GOOGLE_MODEL ?? 'gemini-2.5-flash';

const OBSERVATION: Observation = {
  state: 'separation=140 yourHealth=100 theirHealth=88 yourMeter=40 theirCommitmentRemaining=6',
  legalActions: ['advance', 'retreat', 'attack', 'block'],
  tick: 12,
};

describe.skipIf(!LIVE || API_KEY.trim().length === 0)('live Google AI Studio smoke (opt-in)', () => {
  it('plays one real Decision Point and reports usage', async () => {
    const client = createGoogleClient({ apiKey: API_KEY, model: MODEL });
    const deployment = createDeployment({ client });

    const prompt = deployment.observe(OBSERVATION, 25_000, false);
    const decision = await deployment.decide(prompt);

    expect(OBSERVATION.legalActions).toContain(decision.action);
    expect(decision.tokensSpent).not.toBeNull();
    expect(decision.tokensSpent).toBeGreaterThan(0);
    expect(decision.provider).toBe('google-ai-studio');
    expect(decision.rawResponse.length).toBeGreaterThan(0);
  }, 60_000);

  it('caps the reply at max_tokens=8 in Reflex Mode and still parses (INV-4)', async () => {
    const client = createGoogleClient({ apiKey: API_KEY, model: MODEL });
    const deployment = createDeployment({ client });

    const prompt = deployment.observe(OBSERVATION, 0, true);
    const decision = await deployment.decide(prompt);

    expect(prompt.reflexMode).toBe(true);
    expect(OBSERVATION.legalActions).toContain(decision.action);
    expect(decision.tokensSpent).not.toBeNull();
    expect(decision.tokensSpent).toBeLessThanOrEqual(8);
  }, 60_000);
});
