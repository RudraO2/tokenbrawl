import type { AgentIdentity, DeploymentIdentity, MeteringProbeResult } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { buildCommandLog, computeConfigHash, validateCommandLog } from '../../core/src/command-log';
import { runMatch } from '../../core/src/match-runner';
import { createScriptedAgent } from '../../core/src/testing/mock-agent';
import { createMockEnvironment } from '../../core/src/testing/mock-environment';
import type { MeteringProbeOutcome } from './metering-probe';
import {
  applyMeteringProbe,
  deploymentIdentityFrom,
  formatMeteringExclusions,
  partitionByTrack,
  trackFor,
  withMeteringProbe,
} from './track';

/**
 * Story 3.4, AC3 and AC4.
 *
 * AC3 is a claim about what *cannot* happen -- a Deployment whose probe result
 * is anything but `reports-reasoning` never appearing on the main leaderboard
 * -- so the load-bearing cases here are the exhaustive one (every value of the
 * frozen enum, plus the unprobed case) and the totality one (nothing falls out
 * of both lists, and every Reflex-Track entry has a stated reason). A test that
 * only checked the happy classification would pass against a `trackFor` that
 * returned `'main'` for everything it did not recognise.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const ALL_RESULTS: readonly MeteringProbeResult[] = [
  'reports-reasoning',
  'reports-completion-only',
  'no-usage-reported',
];

function deployment(id: string, result?: MeteringProbeResult, track?: 'main' | 'reflex'): AgentIdentity {
  const identity: DeploymentIdentity = {
    provider: 'groq',
    endpoint: GROQ_ENDPOINT,
    model: id,
    ...(result !== undefined ? { meteringProbe: result } : {}),
  };
  return {
    id,
    kind: 'deployment',
    deployment: identity,
    ...(track !== undefined ? { track } : {}),
  };
}

describe('trackFor (INV-5)', () => {
  it('admits reports-reasoning to the main leaderboard', () => {
    expect(trackFor('reports-reasoning')).toBe('main');
  });

  it('sends every other classification to the Reflex Track', () => {
    for (const result of ALL_RESULTS.filter((value) => value !== 'reports-reasoning')) {
      expect(trackFor(result)).toBe('reflex');
    }
  });

  it('sends an unprobed Deployment to the Reflex Track', () => {
    // INV-5 is "every Deployment is probed *before* it is ranked". Defaulting
    // the missing case to `main` is how that gets lost to an omission rather
    // than to a decision.
    expect(trackFor(undefined)).toBe('reflex');
  });

  it('admits exactly one of the three frozen values, and no more', () => {
    expect(ALL_RESULTS.filter((result) => trackFor(result) === 'main')).toStrictEqual([
      'reports-reasoning',
    ]);
  });
});

describe('persisting the probe result onto a DeploymentIdentity', () => {
  it('returns a frozen copy carrying the result, leaving the original untouched', () => {
    const original: DeploymentIdentity = {
      provider: 'groq',
      endpoint: GROQ_ENDPOINT,
      model: 'llama-3.1-8b-instant',
    };
    const updated = withMeteringProbe(original, 'reports-completion-only');

    expect(updated.meteringProbe).toBe('reports-completion-only');
    expect(original.meteringProbe).toBeUndefined();
    expect(Object.isFrozen(updated)).toBe(true);
  });

  it('builds a DeploymentIdentity straight from a probe outcome, provider and endpoint included (INV-6)', () => {
    const outcome: MeteringProbeOutcome = {
      id: 'groq:llama-3.1-8b-instant',
      provider: 'groq',
      endpoint: GROQ_ENDPOINT,
      model: 'llama-3.1-8b-instant',
      result: 'reports-reasoning',
      usage: { tokensSpent: 260, reasoningTokens: 190 },
    };

    expect(deploymentIdentityFrom(outcome)).toStrictEqual({
      provider: 'groq',
      endpoint: GROQ_ENDPOINT,
      model: 'llama-3.1-8b-instant',
      meteringProbe: 'reports-reasoning',
    });
  });

  it('records the result and the track it forces, together', () => {
    for (const result of ALL_RESULTS) {
      const applied = applyMeteringProbe(deployment('contender'), result);
      expect(applied.deployment?.meteringProbe).toBe(result);
      expect(applied.track).toBe(trackFor(result));
    }
  });

  it('never promotes an entry already marked Reflex Track', () => {
    const applied = applyMeteringProbe(deployment('contender', undefined, 'reflex'), 'reports-reasoning');
    expect(applied.track).toBe('reflex');
    expect(applied.deployment?.meteringProbe).toBe('reports-reasoning');
  });

  it('leaves a Baseline Bot untouched', () => {
    // A Bot consumes nothing and has no Deployment identity to record a probe
    // against; writing one would be a fiction.
    const bot: AgentIdentity = { id: 'bot:spacing', kind: 'bot' };
    expect(applyMeteringProbe(bot, 'no-usage-reported')).toBe(bot);
  });

  it('leaves a Deployment entry with no deployment identity untouched', () => {
    const orphan: AgentIdentity = { id: 'contender', kind: 'deployment' };
    expect(applyMeteringProbe(orphan, 'reports-reasoning')).toBe(orphan);
  });
});

describe('partitioning results by track (AC3)', () => {
  it('keeps every classification but reports-reasoning off the main leaderboard', () => {
    const entries = [
      deployment('honest', 'reports-reasoning'),
      deployment('completion-only', 'reports-completion-only'),
      deployment('silent', 'no-usage-reported'),
      deployment('unprobed'),
    ];

    const partition = partitionByTrack(entries);

    expect(partition.mainLeaderboard.map((entry) => entry.id)).toStrictEqual(['honest']);
    expect(partition.reflexTrack.map((entry) => entry.id)).toStrictEqual([
      'completion-only',
      'silent',
      'unprobed',
    ]);
  });

  it('keeps a reports-completion-only Deployment off the main leaderboard on its own', () => {
    // The story names this case specifically: the documented real behaviour is
    // a Deployment that looks honest until structured output is combined in.
    const partition = partitionByTrack([deployment('drops-under-structured', 'reports-completion-only')]);
    expect(partition.mainLeaderboard).toStrictEqual([]);
    expect(partition.reflexTrack).toHaveLength(1);
  });

  it('puts Baseline Bots on the main leaderboard with no exclusion', () => {
    const bot: AgentIdentity = { id: 'bot:spacing', kind: 'bot' };
    const partition = partitionByTrack([bot, deployment('silent', 'no-usage-reported')]);

    expect(partition.mainLeaderboard).toStrictEqual([bot]);
    expect(partition.exclusions.map((exclusion) => exclusion.id)).toStrictEqual(['silent']);
  });

  it('keeps an explicitly Reflex-Track entry there even when its probe passed', () => {
    const partition = partitionByTrack([deployment('opted-out', 'reports-reasoning', 'reflex')]);

    expect(partition.mainLeaderboard).toStrictEqual([]);
    expect(partition.exclusions[0].result).toBe('reports-reasoning');
    expect(partition.exclusions[0].reason).toContain('configured as Reflex Track');
    // And it must not claim the Deployment was never probed -- that would be a
    // false statement in published output, which is AC4 inverted.
    expect(partition.exclusions[0].reason).not.toContain('never probed');
  });

  it('will not let an explicit track: main override a failed probe (AC3)', () => {
    // The one direction that would defeat the whole invariant: a config that
    // asserts a Deployment belongs on the leaderboard, against what the probe
    // found. Only `reflex` is honoured as an explicit override, and only
    // because it is the safe direction.
    const partition = partitionByTrack([
      deployment('insists', 'no-usage-reported', 'main'),
      deployment('also-insists', 'reports-completion-only', 'main'),
    ]);

    expect(partition.mainLeaderboard).toStrictEqual([]);
    expect(partition.reflexTrack).toHaveLength(2);
    expect(partition.exclusions.map((exclusion) => exclusion.id)).toStrictEqual([
      'insists',
      'also-insists',
    ]);
  });

  it('excludes a Deployment entry that carries no deployment identity at all', () => {
    const partition = partitionByTrack([{ id: 'orphan', kind: 'deployment' }]);

    expect(partition.mainLeaderboard).toStrictEqual([]);
    expect(partition.exclusions[0].result).toBeUndefined();
    expect(partition.exclusions[0].reason).toContain('never probed');
  });

  it('is total: nothing falls out of both lists, and every Reflex entry has a reason (AC4)', () => {
    const entries = [
      deployment('honest', 'reports-reasoning'),
      deployment('completion-only', 'reports-completion-only'),
      deployment('silent', 'no-usage-reported'),
      deployment('unprobed'),
      deployment('opted-out', 'reports-reasoning', 'reflex'),
      { id: 'bot:spacing', kind: 'bot' } as AgentIdentity,
      { id: 'orphan', kind: 'deployment' } as AgentIdentity,
    ];

    const partition = partitionByTrack(entries);

    expect(partition.mainLeaderboard.length + partition.reflexTrack.length).toBe(entries.length);
    expect(partition.exclusions).toHaveLength(partition.reflexTrack.length);
    expect(partition.exclusions.map((exclusion) => exclusion.id)).toStrictEqual(
      partition.reflexTrack.map((entry) => entry.id),
    );
    for (const exclusion of partition.exclusions) {
      expect(exclusion.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns frozen lists, and an empty partition for an empty set', () => {
    const partition = partitionByTrack([]);
    expect(partition.mainLeaderboard).toStrictEqual([]);
    expect(partition.reflexTrack).toStrictEqual([]);
    expect(partition.exclusions).toStrictEqual([]);
    expect(Object.isFrozen(partition)).toBe(true);
    expect(Object.isFrozen(partition.exclusions)).toBe(true);
  });
});

describe('publishing exclusions (AC4)', () => {
  it('names the Deployment, its classification, and why it is excluded', () => {
    const partition = partitionByTrack([
      deployment('honest', 'reports-reasoning'),
      deployment('completion-only', 'reports-completion-only'),
      deployment('silent', 'no-usage-reported'),
      deployment('unprobed'),
    ]);

    const lines = formatMeteringExclusions(partition.exclusions);

    expect(lines).toHaveLength(3);
    for (const [index, line] of lines.entries()) {
      expect(line).toContain(partition.exclusions[index].id);
      expect(line).toContain('Reflex Track only');
      expect(line).toContain(partition.exclusions[index].reason);
    }
    expect(lines[0]).toContain('reports-completion-only');
    expect(lines[1]).toContain('no-usage-reported');
    expect(lines[2]).toContain('not run');
    // Silent omission is the defect: nothing that was excluded may be missing
    // from the published lines.
    expect(lines).toHaveLength(partition.reflexTrack.length);
  });

  it('produces nothing for a clean set, rather than a placeholder line', () => {
    const partition = partitionByTrack([deployment('honest', 'reports-reasoning')]);
    expect(formatMeteringExclusions(partition.exclusions)).toStrictEqual([]);
  });
});

describe('the probe result on disk', () => {
  it('reaches a schema-valid Command Log as meteringProbe and track', async () => {
    const env = createMockEnvironment();
    // Long enough that the mock environment reaches its own terminal condition
    // rather than the script running out first.
    const contender = createScriptedAgent({
      id: 'groq:llama-3.1-8b-instant',
      kind: 'deployment',
      script: Array.from({ length: 64 }, () => 'attack' as const),
      usage: [{ tokensSpent: 12, reasoningTokens: 5 }],
    });
    const bot = createScriptedAgent({
      id: 'bot:spacing',
      script: Array.from({ length: 64 }, () => 'block' as const),
    });
    const match = await runMatch(env, [contender, bot], 7, { tokenBankStart: 500 });

    const outcome: MeteringProbeOutcome = {
      id: contender.id,
      provider: 'groq',
      endpoint: GROQ_ENDPOINT,
      model: 'llama-3.1-8b-instant',
      result: 'reports-completion-only',
      usage: { tokensSpent: 260, reasoningTokens: null },
    };

    const probed = applyMeteringProbe(
      { id: contender.id, kind: 'deployment', deployment: deploymentIdentityFrom(outcome) },
      outcome.result,
    );

    const log = buildCommandLog(match, {
      environment: { id: env.id, version: env.version },
      seed: 7,
      configHash: computeConfigHash({}),
      agents: [probed, { id: bot.id, kind: 'bot' }],
    });

    expect(() => validateCommandLog(log)).not.toThrow();
    expect(log.agents[0].deployment?.meteringProbe).toBe('reports-completion-only');
    expect(log.agents[0].track).toBe('reflex');
  });
});
