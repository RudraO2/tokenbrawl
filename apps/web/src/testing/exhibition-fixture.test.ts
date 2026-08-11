import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateCommandLogV2 } from '../../../../packages/core/src/command-log-v2';
import { ratingEligibility } from '../../../../packages/core/src/rating-eligibility';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { reasoningView } from '../main';
import { buildReplayFilm } from '../replay/film';
import { createReasoningSource, validateReasoningSidecar } from '../replay/sidecar';
import { createBankReadout } from '../replay/token-bank';
import { resolveDecision } from '../replay/decision-point';
import {
  EXHIBITION_FIXTURE_ENDPOINT,
  EXHIBITION_FIXTURE_PROVIDER,
  EXHIBITION_FIXTURE_SIDECAR_PATH,
  buildExhibitionFixture,
} from './exhibition-fixture';

/**
 * Story 12.12: the four player paths that had never met a Deployment log.
 *
 * Every committed Command Log in this repository is Baseline Bot versus Baseline
 * Bot, with `reasoning: null` on all 379 submissions and no `bankRemaining`
 * anywhere. So the reasoning panel's text branch, its attribution, the Token
 * Bank HUD and the Parse Failure treatment have all shipped for eight epics
 * without a single test or screenshot exercising them against the data they were
 * written for. This file is that exercise, against a fixture built through the
 * real writers (see `exhibition-fixture.ts`).
 *
 * The fixture is built once per case rather than shared in a `beforeAll`: it is
 * a few milliseconds of pure simulation, and a shared frozen document that one
 * case mutates is a debugging afternoon nobody wants.
 */

const TICKS_PER_DECISION = DEFAULT_FIGHTER_CONFIG.ticksPerDecision;

/** The panel for one fighter at one playback position, exactly as `main.ts` assembles it. */
function panelAt(
  log: Parameters<typeof createReasoningSource>[0] & { readonly agents: readonly { readonly id: string }[] },
  source: ReturnType<typeof createReasoningSource>,
  decisionPoint: number,
  agentIndex: 0 | 1,
): ReturnType<typeof reasoningView> {
  const resolved = resolveDecision(
    decisionPoint,
    agentIndex,
    (tick, agent) => source.at(tick, agent).found,
    TICKS_PER_DECISION,
  );
  return reasoningView(source.at(resolved?.tick ?? -1, agentIndex), resolved, log.agents[agentIndex].id);
}

describe('the exhibition fixture is a real v2 Deployment log', () => {
  it('validates against the frozen v2 schema and replays to its own hash', async () => {
    const { log } = await buildExhibitionFixture();

    expect(log.schemaVersion).toBe('2.0.0');
    // Throws on a document the frozen schema rejects, so no assertion is needed
    // beyond the call itself -- but the returned value is checked so a validator
    // that started returning `undefined` could not pass this vacuously.
    expect(validateCommandLogV2(log).matchId).toBe(log.matchId);

    const film = buildReplayFilm(log, createFighterEnvironment());
    expect(film.matchesRecordedHash).toBe(true);
    expect(film.divergences).toStrictEqual([]);
  });

  it('is deterministic: two builds are byte-identical', async () => {
    const first = await buildExhibitionFixture();
    const second = await buildExhibitionFixture();

    expect(JSON.stringify(second.log)).toBe(JSON.stringify(first.log));
    expect(JSON.stringify(second.sidecar)).toBe(JSON.stringify(first.sidecar));
  });

  it('records a provider, an endpoint and a token cost on every Deployment decision (INV-6)', async () => {
    const { inlineLog } = await buildExhibitionFixture();

    expect(inlineLog.decisions.length).toBeGreaterThan(0);
    for (const decision of inlineLog.decisions) {
      expect(decision.provider).toBe(EXHIBITION_FIXTURE_PROVIDER);
      expect(decision.endpoint).toBe(EXHIBITION_FIXTURE_ENDPOINT);
      // `null` would be a Metering Probe result, which is a legitimate state but
      // not the one this fixture is modelling -- and a bank cannot be drawn from
      // it. Asserted so a change to `openai-wire.ts`'s `reportedCount` that
      // started dropping counts shows up here.
      expect(decision.tokensSpent).toBeTypeOf('number');
      expect(decision.bankRemaining).toBeTypeOf('number');
    }
  });

  it('externalises reasoning into a sidecar that binds to this Match', async () => {
    const { log, sidecar } = await buildExhibitionFixture();

    expect(log.reasoningSidecar).toBe(EXHIBITION_FIXTURE_SIDECAR_PATH);
    expect(validateReasoningSidecar(sidecar, log.matchId).entries).toHaveLength(
      log.decisions.length,
    );
    // The split moved the text out. A `reasoning` still on a non-failing entry
    // would mean the document carries it twice and the sidecar is decoration.
    for (const decision of log.decisions) {
      expect(decision.reasoning).toBeUndefined();
    }
    // But it did NOT move the attribution: that is INV-6's per-call record and
    // the panel reads it off the log precisely so a shed sidecar cannot take it.
    for (const decision of log.decisions) {
      expect(decision.provider).toBe(EXHIBITION_FIXTURE_PROVIDER);
      expect(decision.endpoint).toBe(EXHIBITION_FIXTURE_ENDPOINT);
    }
  });
});

describe('hover reasoning against a Deployment log (AC2)', () => {
  it('shows the decision\'s real reasoning text once the sidecar is adopted', async () => {
    const { log, sidecar } = await buildExhibitionFixture();
    const source = createReasoningSource(log);

    // Before adoption: `loading`, never a blank or an error (4.2 AC4).
    expect(panelAt(log, source, 0, 0).bodyModifier).toBe('tb-reasoning--loading');

    source.adopt(validateReasoningSidecar(sidecar, log.matchId));
    const view = panelAt(log, source, 0, 0);

    expect(view.bodyModifier).toBe('tb-reasoning--text');
    expect(view.body.length).toBeGreaterThan(40);
    // The actual sentence the "model" produced, not a placeholder and not the
    // raw response -- the two are different strings in the fixture on purpose.
    expect(view.body).toContain('Distance is 320 units');
    expect(view.body).not.toBe(view.rawResponse);
  });

  it('shows the provider and endpoint on the Decision Point (AC2, INV-6)', async () => {
    const { log, sidecar } = await buildExhibitionFixture();
    const source = createReasoningSource(log);
    source.adopt(validateReasoningSidecar(sidecar, log.matchId));

    for (const agentIndex of [0, 1] as const) {
      const view = panelAt(log, source, 0, agentIndex);
      expect(view.provider).toBe(EXHIBITION_FIXTURE_PROVIDER);
      expect(view.endpoint).toBe(EXHIBITION_FIXTURE_ENDPOINT);
    }
  });

  it('keeps the attribution when the sidecar never arrives', async () => {
    // The load-bearing half of putting provider/endpoint on the log rather than
    // in the sidecar. A page whose sheddable document 404s still attributes the
    // call, which is what makes INV-6 a property of the published artefact
    // rather than of a lucky fetch.
    const { log } = await buildExhibitionFixture();
    const source = createReasoningSource(log);
    source.markUnavailable('fetch failed');

    const view = panelAt(log, source, 0, 0);
    expect(view.bodyModifier).toBe('tb-reasoning--absent');
    expect(view.provider).toBe(EXHIBITION_FIXTURE_PROVIDER);
    expect(view.endpoint).toBe(EXHIBITION_FIXTURE_ENDPOINT);
  });
});

describe('the Token Bank HUD against a real budget (AC3)', () => {
  it('tracks both fighters and drains, where a Baseline Bot log tracks neither', async () => {
    const { log } = await buildExhibitionFixture();
    const banks = createBankReadout(log, TICKS_PER_DECISION);

    for (const agentIndex of [0, 1] as const) {
      expect(banks.tracked(agentIndex)).toBe(true);
    }

    const opening = banks.at(0, 0);
    const later = banks.at(6, 0);
    expect(opening).not.toBeNull();
    expect(later).not.toBeNull();
    // A *level* that fell, which is what the meter draws. The empty meter a
    // Baseline Bot produces is `tracked === false` and no bar at all.
    expect(later?.remaining ?? 0).toBeLessThan(opening?.remaining ?? 0);
    expect(opening?.start).toBeGreaterThan(0);
    expect(opening?.filledBasisPoints).toBeGreaterThan(later?.filledBasisPoints ?? 0);
    expect(opening?.exhausted).toBe(false);
  });

  it('the committed Baseline-Bot demo tracks no bank, which is the gap this fixture stands in for', () => {
    // Not a test of the fixture -- a measurement of the corpus, kept here so the
    // claim in the story file ("the Token Bank HUD has never drawn a real
    // budget") is asserted rather than remembered.
    const demoPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'public',
      'replays',
      'demo.command-log.json',
    );
    const demo = JSON.parse(readFileSync(demoPath, 'utf8')) as Parameters<typeof createBankReadout>[0];
    const banks = createBankReadout(demo, TICKS_PER_DECISION);

    expect(banks.tracked(0)).toBe(false);
    expect(banks.tracked(1)).toBe(false);
  });
});

describe('a Parse Failure reads as a Parse Failure (AC4)', () => {
  it('is recorded as the Fallback Action with its raw response kept inline', async () => {
    const { log } = await buildExhibitionFixture();
    const failures = log.decisions.filter((decision) => decision.parseFailure === true);

    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.action).toBe('stand');
      // The frozen schema requires it on the entry itself, and Story 1.6's
      // discipline is that a failure is published to be audited.
      expect(failure.rawResponse).toBeTypeOf('string');
      expect(String(failure.rawResponse).length).toBeGreaterThan(0);
    }
  });

  it('renders in the warn treatment, and only the failing side does', async () => {
    const { log, sidecar } = await buildExhibitionFixture();
    const source = createReasoningSource(log);
    source.adopt(validateReasoningSidecar(sidecar, log.matchId));

    const failure = log.decisions.find((decision) => decision.parseFailure === true);
    expect(failure).toBeDefined();
    const decisionPoint = (failure?.tick ?? 0) / TICKS_PER_DECISION;
    const failingSide = failure?.agentIndex ?? 0;
    const otherSide = failingSide === 0 ? 1 : 0;

    const failed = panelAt(log, source, decisionPoint, failingSide);
    expect(failed.bodyModifier).toBe('tb-reasoning--warn');
    expect(failed.chips.map((chip) => chip.label)).toContain('Parse failure');
    expect(failed.body).toMatch(/Fallback Action/);
    expect(failed.rawResponse).toBe(failure?.rawResponse);

    // Not a gap, and not the other fighter's problem.
    const fine = panelAt(log, source, decisionPoint, otherSide);
    expect(fine.chips.map((chip) => chip.label)).not.toContain('Parse failure');
  });

  it('is styled as --tb-bg ink on a --tb-warn fill, not warn text (docs/DESIGN.md)', () => {
    // `--tb-warn` on `--tb-bg` measures 4.26:1 and misses the text floor; the
    // same pair inverted clears it because the block is solid. The rule is in
    // the stylesheet and this is the assertion that it stays there -- a
    // behavioural test cannot see a colour, and the AC is about the colour.
    const cssPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'styles',
      'app.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    const rule = css.slice(css.indexOf('.tb-reasoning--warn'));
    const block = rule.slice(0, rule.indexOf('}'));

    expect(block).toMatch(/background:\s*var\(--tb-warn\)/);
    expect(block).toMatch(/color:\s*var\(--tb-bg\)/);
  });
});

describe('the exhibition is not a ranked result (AC5)', () => {
  /**
   * The answer `ratingEligibility` actually gives, and the mechanism that
   * actually excludes the log.
   *
   * The story's AC reads "`ratingEligibility` is asked, then it is excluded from
   * the leaderboard", and the honest reading of "asserts the answer rather than
   * assuming it" is to record what the answer is. It is **eligible**: the two
   * exclusions the predicate knows are `byok` (a visitor's own key) and `human`
   * (an arcade Match), and this is neither -- it is two Deployments on this
   * project's key, which is exactly what a rated tournament Match is.
   *
   * Claiming otherwise would mean writing `provider: "byok"` or `kind: "human"`
   * into the log, which would be a false statement about how the Match was run
   * in the one document this project asks to be trusted.
   *
   * What excludes it is the corpus reader: `packages/cli/src/leaderboard.ts`
   * validates every candidate with the **v1** `validateCommandLog`, and this is a
   * v2 document, so it lands in `unreadable` and is never rated -- the same way
   * the six v2 Spectate logs sitting in that directory already are. Both facts
   * are asserted below, and the story file records the reading.
   */
  it('is rating-eligible by the predicate, and the story records why that is the honest answer', async () => {
    const { log } = await buildExhibitionFixture();
    const eligibility = ratingEligibility(log);

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.exclusion).toBeNull();
    // Neither lie is told to buy an exclusion.
    expect(log.agents.some((agent) => agent.kind === 'human')).toBe(false);
    expect(log.agents.some((agent) => agent.deployment?.provider === 'byok')).toBe(false);
  });

  it('is excluded from the board by the v1-only corpus reader', async () => {
    const { log } = await buildExhibitionFixture();
    const { validateCommandLog } = await import('../../../../packages/core/src/command-log');

    // The exact call `loadCorpus` makes. A throw is what puts a file in
    // `unreadable`, and `unreadable` files are never rated.
    expect(() => validateCommandLog(log)).toThrow(/2\.0\.0|schemaVersion/);
  });
});
