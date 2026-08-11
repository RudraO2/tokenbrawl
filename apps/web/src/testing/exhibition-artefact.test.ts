import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandLogV2 } from '@tokenbrawl/contracts';
import { validateCommandLogV2 } from '../../../../packages/core/src/command-log-v2';
import { DEFAULT_TOKEN_BANK_START } from '../../../../packages/core/src/token-bank';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { reasoningView } from '../main';
import { buildReplayFilm } from '../replay/film';
import { resolveDecision } from '../replay/decision-point';
import { createReasoningSource, validateReasoningSidecar } from '../replay/sidecar';
import { createBankReadout } from '../replay/token-bank';
import { DEMO_REPLAY_URL } from '../startup';

/**
 * Story 12.12: the shipped exhibition replay, asserted rather than trusted.
 *
 * This is the operator half of the story made into a test. The document under
 * `apps/web/public/replays/` was produced by one run of
 * `apps/web/scripts/build-exhibition-replay.mts` against Groq's live free-tier
 * endpoint, and a generated artefact nobody re-checks is exactly how a corpus
 * quietly stops meaning what it claims -- the audit sweep for the Spectate stream
 * exists for the same reason (Story 12.11).
 *
 * The point of every case here is that it fails if the flagship ever reverts to a
 * Baseline Bot log. Two Baseline Bots satisfy the schema, replay to their own
 * hash, and pass every check in this repository written before this story; what
 * they cannot do is carry reasoning, a provider, an endpoint or a Token Bank.
 */

const REPLAYS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'replays');
const LOG_NAME = 'exhibition.command-log.json';
const SIDECAR_NAME = 'exhibition.reasoning.json';
const TICKS_PER_DECISION = DEFAULT_FIGHTER_CONFIG.ticksPerDecision;

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(REPLAYS, name), 'utf8'));
}

const log = validateCommandLogV2(readJson(LOG_NAME));
const sidecar = validateReasoningSidecar(readJson(SIDECAR_NAME), log.matchId);

describe('the shipped exhibition replay is a real Deployment-vs-Deployment Match', () => {
  it('is v2, validates against the frozen schema, and names its own sidecar', () => {
    expect(log.schemaVersion).toBe('2.0.0');
    expect(log.reasoningSidecar).toBe(SIDECAR_NAME);
    expect(log.decisions.length).toBeGreaterThan(20);
  });

  it('re-simulates to its own Final-State Hash (INV-2)', () => {
    // The whole claim of the artefact. A log that did not replay to its own hash
    // would be a recording wearing a replay's clothes.
    const film = buildReplayFilm(log, createFighterEnvironment());

    expect(film.matchesRecordedHash).toBe(true);
    expect(film.finalStateHash).toBe(log.finalStateHash);
    expect(film.divergences).toStrictEqual([]);
    expect(film.result).toStrictEqual(log.result);
  });

  it('has two Deployments on it and no Baseline Bot on either side', () => {
    for (const agent of log.agents) {
      expect(agent.kind).toBe('deployment');
      expect(agent.deployment?.provider).toBe('groq');
      // https, and the allowlisted free-tier host. INV-8 is not loosened, and a
      // key never travels in clear.
      expect(agent.deployment?.endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(agent.deployment?.model).toMatch(/^openai\/gpt-oss-/);
    }
    // Two *different* models, so the Match is a comparison rather than a mirror.
    expect(log.agents[0].deployment?.model).not.toBe(log.agents[1].deployment?.model);
  });

  it('carries provider, endpoint and a metered token cost on every decision (INV-6, INV-4)', () => {
    for (const decision of log.decisions) {
      expect(decision.provider).toBe('groq');
      expect(decision.endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
      // `null` here would be a Metering Probe result rather than a cost, and the
      // bank cannot be drawn from one.
      expect(decision.tokensSpent).toBeTypeOf('number');
      expect(decision.reasoningTokens).toBeTypeOf('number');
      expect(decision.bankRemaining).toBeTypeOf('number');
    }
  });

  it('spends a real Token Bank, and it visibly drains', () => {
    expect(log.tokenBankStart).toBe(DEFAULT_TOKEN_BANK_START);

    const banks = createBankReadout(log, TICKS_PER_DECISION);
    for (const agentIndex of [0, 1] as const) {
      expect(banks.tracked(agentIndex)).toBe(true);
    }

    const levels = log.decisions
      .map((decision) => decision.bankRemaining)
      .filter((level): level is number => typeof level === 'number');
    const floor = Math.min(...levels);

    // Not merely "a number was written": the meter has to move enough for a
    // visitor to see it move. A tenth of the bank is the floor for that claim.
    expect(floor).toBeLessThan(DEFAULT_TOKEN_BANK_START * 0.9);
    // And it must not have emptied, or the Match would be Reflex Mode throughout
    // and there would be no reasoning to read -- which is what this replay is for.
    expect(floor).toBeGreaterThan(0);
    expect(log.decisions.every((decision) => decision.reflexMode !== true)).toBe(true);
  });

  it('has a sidecar entry for every decision, every one with real reasoning text', () => {
    expect(sidecar.entries).toHaveLength(log.decisions.length);

    for (const entry of sidecar.entries) {
      expect(entry.reasoning).toBeTypeOf('string');
      // A model's deliberation, not a label. The committed replay's shortest is
      // 270 characters; 100 is a floor no bot log could ever clear.
      expect(String(entry.reasoning).length).toBeGreaterThan(100);
    }
  });

  it('keeps the reasoning out of the log, so playback never blocks on it (AD-10)', () => {
    for (const decision of log.decisions) {
      expect(decision.reasoning).toBeUndefined();
    }
  });

  /**
   * Story 4.2's first-frame payload budget, moved onto the document that now
   * blocks (Story 12.12).
   *
   * `demo-log.test.ts` asserts the same 32 KB against `demo.command-log.json`,
   * which was the preloaded, blocking document until this story repointed
   * `DEMO_REPLAY_URL`. An independent review caught that the budget was left
   * guarding a file no longer on the critical path: regenerate the exhibition
   * against a longer Match and the first frame silently blows past it with a green
   * suite. The constant is restated rather than imported because 32 KB is a fact
   * about the *critical path*, not about either document, and both files should
   * fail independently if either grows.
   *
   * The sidecar is deliberately NOT budgeted. It is 125 KB of real deliberation
   * and it is sheddable by design (AD-10): playback never waits for it, and Story
   * 4.2's whole point was moving it off this path. A budget on it would be a
   * budget on how much a model is allowed to think.
   */
  it('fits the first-frame payload budget it is now on the critical path of', () => {
    const budgetBytes = 32 * 1024;
    const size = statSync(join(REPLAYS, LOG_NAME)).size;

    expect(size).toBeLessThan(budgetBytes);
    // Reported so a regeneration that lands close to the ceiling is visible in
    // the run rather than only in a failure.
    expect(size).toBeGreaterThan(0);
  });

  it('is what the page opens on, and what the page preloads', () => {
    expect(DEMO_REPLAY_URL).toBe(`/replays/${LOG_NAME}`);

    // The HTML attribute, which no other test can see. A preload pointing at a
    // document the page does not fetch is a wasted round trip on the critical
    // path plus a cold fetch of the one that blocks.
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'),
      'utf8',
    );
    expect(html).toContain(`href="${DEMO_REPLAY_URL}"`);
  });
});

describe('what a visitor reads on the flagship replay', () => {
  it('shows real model reasoning, with its provider and endpoint, on both fighters', () => {
    const source = createReasoningSource(log);
    source.adopt(sidecar);

    for (const agentIndex of [0, 1] as const) {
      const resolved = resolveDecision(
        0,
        agentIndex,
        (tick, agent) => source.at(tick, agent).found,
        TICKS_PER_DECISION,
      );
      const view = reasoningView(
        source.at(resolved?.tick ?? -1, agentIndex),
        resolved,
        log.agents[agentIndex].id,
      );

      expect(view.bodyModifier).toBe('tb-reasoning--text');
      expect(view.body.length).toBeGreaterThan(100);
      expect(view.provider).toBe('groq');
      expect(view.endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
    }
  });

  /**
   * The Parse Failure this replay actually contains, and why its copy is what it
   * is.
   *
   * At tick 960 `openai/gpt-oss-20b` spent 2,046 of its 2,048 completion tokens
   * reasoning and returned `content: ""`. `parseAction` found no Action, `runMatch`
   * applied the Fallback Action `stand`, and the frozen schema kept the empty
   * `rawResponse` on the entry. Parse Failures are a first-class metric in
   * `docs/INVARIANTS.md` and this replay is the only surface a visitor meets one
   * on, so an empty completion has to read as the finding it is rather than as a
   * blank box.
   */
  it('renders its one Parse Failure as a Parse Failure, in the warn treatment', () => {
    const failures = log.decisions.filter((decision) => decision.parseFailure === true);
    expect(failures.length).toBeGreaterThan(0);

    const source = createReasoningSource(log);
    source.adopt(sidecar);

    for (const failure of failures) {
      expect(failure.action).toBe('stand');
      // Present -- required by the frozen schema on a failing entry -- even when
      // it is the empty string, which is the honest record of an empty completion.
      expect(failure.rawResponse).toBeTypeOf('string');

      const decisionPoint = failure.tick / TICKS_PER_DECISION;
      const view = reasoningView(
        source.at(failure.tick, failure.agentIndex),
        { tick: failure.tick, decisionPoint, polled: true },
        log.agents[failure.agentIndex].id,
      );

      expect(view.bodyModifier).toBe('tb-reasoning--warn');
      expect(view.chips.map((chip) => chip.label)).toContain('Parse failure');
      expect(view.body).toMatch(/not retried/i);
      if (failure.rawResponse === '') {
        expect(view.body).toMatch(/no content at all/);
      }
      // Attributed either way: a Parse Failure is the entry most worth attributing.
      expect(view.provider).toBe('groq');
    }
  });

  it('contains an Ultimate, so the cinematic is reachable from the landing replay', () => {
    // Not an acceptance criterion of this story -- a measurement worth pinning.
    // Epic 10's Super Gauge and Epic 11's three-act cinematic hung off one
    // submission in the entire v1 corpus (Story 12.11); the flagship carrying one
    // means a visitor can meet it without navigating to Spectate.
    expect(log.decisions.filter((decision) => decision.action === 'special').length).toBeGreaterThan(
      0,
    );
  });

  it('contains no API key, in the log or the sidecar', () => {
    // `scripts/assert-no-secret-leak.sh` is the real gate and needs the key in
    // the environment to run. This is the shape check that runs everywhere: a
    // Groq key is `gsk_...`, and `rawResponse` and `reasoning` are free-form
    // provider strings, which is the one way one could reach these documents.
    const keyish = /\b(gsk_[A-Za-z0-9]{8,}|csk-[A-Za-z0-9]{8,}|AIzaSy[A-Za-z0-9_-]{8,}|Bearer\s+\S{8,})/;
    expect(JSON.stringify(log)).not.toMatch(keyish);
    expect(JSON.stringify(sidecar)).not.toMatch(keyish);
  });
});

/**
 * Story 12.12, AC5, and the finding an independent review of this story made.
 *
 * The exhibition is excluded from the leaderboard today, and the reason is worth
 * stating precisely because it is *not* the reason the AC implies:
 *
 *  - `configs/exhibition.config.json`'s `"ranked": false` does **nothing** here. It
 *    feeds `validateTournamentConfig`'s shared-quota warning and is never written
 *    into a Command Log, so the corpus reader cannot see it. The config's own
 *    comment calls it "a statement rather than a formality"; it is a statement.
 *  - `ratingEligibility` reports the Match **eligible**, correctly: its two
 *    exclusions are `byok` (a visitor's own key) and `human` (an arcade Match) and
 *    this is neither. Writing either into the log to buy an exclusion would be a
 *    false statement about how the Match was run, in the one document this project
 *    asks to be trusted.
 *  - What actually excludes it is `packages/cli/src/leaderboard.ts`'s `loadCorpus`,
 *    which validates every candidate with the **v1** `validateCommandLog` and files
 *    a throw under `unreadable`. This log is v2 and lives in the tournament's own
 *    `outputDir`, so it is excluded the same way the six v2 Spectate logs beside it
 *    already are.
 *
 * That is incidental protection, and the review is right that it is one obvious
 * refactor from breaking: the whole replay corpus is v2 now, so making `loadCorpus`
 * v2-capable is a natural next change, and on the day it lands the exhibition
 * becomes a rated single-Match observation between two Groq Deployments sharing one
 * quota, with nothing failing. So the mechanism is pinned here, at the layer that
 * decides, with the ratchet stated in the failure message rather than in a comment
 * nobody reads.
 */
describe('the exhibition is not a ranked result (AC5)', () => {
  it('is excluded by the corpus reader, and says what to do if that ever changes', async () => {
    const { validateCommandLog } = await import('../../../../packages/core/src/command-log');

    let excluded = false;
    try {
      validateCommandLog(log as unknown as CommandLogV2);
    } catch {
      excluded = true;
    }

    expect(
      excluded,
      'The leaderboard corpus reader now accepts this document, so the exhibition Match ' +
        'is about to enter the published ratings. It must not: a single exhibition ' +
        'between two Deployments sharing one provider quota is not a rating ' +
        'observation. `ratingEligibility` will NOT stop it -- it reports this Match ' +
        'eligible, because its only exclusions are `byok` and `human`. Give the rule ' +
        'somewhere real to live (an exclusion `ratingEligibility` can see, or a ' +
        'corpus-reader rule that skips this log by name) before landing the v2 reader.',
    ).toBe(true);
  });

  it('reaches the ratings through the directory the tournament reads, so the exclusion is load-bearing', async () => {
    // The half that makes the above matter. If this log lived somewhere the
    // leaderboard never looks, the exclusion would be geography rather than a rule
    // and the case above would be theatre.
    const config = JSON.parse(
      readFileSync(join(REPLAYS, '..', '..', '..', '..', 'configs', 'exhibition.config.json'), 'utf8'),
    ) as { readonly outputDir: string };
    const tournament = JSON.parse(
      readFileSync(join(REPLAYS, '..', '..', '..', '..', 'configs', 'tournament.config.json'), 'utf8'),
    ) as { readonly outputDir: string };

    expect(config.outputDir).toBe(tournament.outputDir);
    expect(config.outputDir).toBe('apps/web/public/replays');
  });

  it('declares itself unranked in its config, even though nothing downstream reads it', () => {
    // Pinned so the declaration cannot quietly flip to `true` and read as
    // authorisation. It grants nothing today -- see this block's docblock -- and a
    // future story that gives `ranked` teeth should find this already saying no.
    const config = JSON.parse(
      readFileSync(join(REPLAYS, '..', '..', '..', '..', 'configs', 'exhibition.config.json'), 'utf8'),
    ) as { readonly agents: readonly { readonly ranked?: boolean }[] };

    expect(config.agents.every((agent) => agent.ranked === false)).toBe(true);
  });
});
