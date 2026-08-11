import process from 'node:process';
import type { AgentIdentityV2, CommandLogV2 } from '@tokenbrawl/contracts';
import { buildAgent, secretsFor, type AgentDeps } from '../../../packages/cli/src/agents';
import { loadRunConfig, tournamentWarnings, agentConfigById } from '../../../packages/cli/src/config';
import type { CliIo } from '../../../packages/cli/src/io';
import { createNodeIo } from '../../../packages/cli/src/node-io';
import { cliConfigHash, planMatch } from '../../../packages/cli/src/plan';
import { createQuotaTracker } from '../../../packages/cli/src/quota';
import { guardSecrets } from '../../../packages/cli/src/secrets';
import { validateCommandLogV2 } from '../../../packages/core/src/command-log-v2';
import { runMatch } from '../../../packages/core/src/match-runner';
import {
  freeTierLimitsFor,
  loadFreeTierConfig,
} from '../../../packages/providers/src/free-tier';
import { defaultHttpFetch, type HttpFetch } from '../../../packages/providers/src/http';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { splitReasoningV2 } from '../src/testing/sidecar-split';

/**
 * Story 12.12: generates the one exhibition Match between two language models.
 *
 * The claim is in `apps/web/index.html`'s description meta -- "language models
 * fighting under a fixed token budget" -- and what shipped was a corpus of
 * Baseline-Bot-versus-Baseline-Bot Matches in which every `decisions[]` entry
 * read `{ "reasoning": null, "rawResponse": "random:advance", "provider": "bot" }`.
 * Story 4.3's hover reasoning is described in `docs/stories/README.md` as the
 * project's centrepiece feature and there was no committed replay in which it had
 * anything to show. This script is what puts one on the screen.
 *
 * ## Nothing here is new engineering
 *
 * Every part already existed and shipped: Story 3.1's Deployment Agent, 3.2's
 * Groq adapter, 3.5's provenance, 4.3's reasoning sidecar, 5.1's local CLI. So
 * this script *composes* them and adds no path of its own -- the same discipline
 * `packages/cli/src/run.ts` states for itself. It loads the config through
 * `loadRunConfig`, resolves keys through `secretsFor`, wraps the io through
 * `guardSecrets`, builds both Agents through `buildAgent`, and plays the Match
 * through `runMatch`. There is no prompt assembler here, no hasher, no schema
 * literal and no decision mapping.
 *
 * The one thing it does not reuse is `runOneMatch`, and the reason is the schema:
 * that function returns a **v1** `CommandLog` via `buildCommandLog`, and this
 * story's acceptance criterion asks for v2. So the log is assembled from the same
 * `MatchResult` by `buildArcadeCommandLog` -- the v2 writer the Arcade already
 * uses -- exactly as `build-spectate-manifest.mts` does since Story 12.11, and
 * validated against the frozen `command-log.v2.schema.json` before it is written.
 * No contract is widened; `docs/contracts/` is untouched.
 *
 * ## Key hygiene
 *
 * The key is read from the environment and from nowhere else, via the `CliIo`
 * port's `env` (`packages/cli/src/config.ts` rejects a literal key in a config
 * file and says why). `secretsFor` resolves it before a single Match is planned,
 * `guardSecrets` wraps the io before there is anything to redact, and every write
 * below goes through that guarded io -- so a document containing a key is
 * *refused* rather than written, and anything printed is redacted. With no key
 * present this exits non-zero naming `GROQ_API_KEY` and writes nothing at all,
 * which is the one behaviour the dev session could verify end to end before a key
 * existed.
 *
 * ## INV-2: this is a replay, not a recording
 *
 * What is written is the log. The Match a visitor watches is re-simulated from
 * (seed, config, actions) by the same engine CI ran -- the model's responses are
 * an *input* recorded in the document, and they are the only non-deterministic
 * thing about it. `finalStateHash` is verified on replay by the player itself,
 * and by `exhibition-artefact.test.ts` over the committed file.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs \
 *        apps/web/scripts/build-exhibition-replay.mts
 */

/** The config that names the two Deployments. Read, never written. */
const CONFIG_PATH = 'configs/exhibition.config.json';

/** Where the two artefacts land, and the names the player and the tests look for. */
const OUT_DIR = 'apps/web/public/replays';
export const EXHIBITION_LOG_NAME = 'exhibition.command-log.json';
export const EXHIBITION_SIDECAR_NAME = 'exhibition.reasoning.json';

/**
 * Tokens one Decision Point's call costs, for the pacing arithmetic below.
 *
 * Measured against the live endpoint on 2026-08-11 with the real Scaffold: 156
 * prompt tokens for a trimmed probe against ~650 for the full `SCAFFOLD`, plus
 * 186-273 completion tokens including reasoning. 1,100 is that rounded up, so the
 * pacing errs toward waiting rather than toward a 429.
 */
const ESTIMATED_TOKENS_PER_CALL = 1_100;

/** Never pace tighter than this, whatever the arithmetic says. Groq's RPM floor is 30/min. */
const MIN_CALL_GAP_MS = 2_000;

/**
 * A transport that will not outrun this Deployment's free-tier token budget.
 *
 * Why this exists, and why it is here rather than in the adapter: 8,000 TPM
 * against ~1,100 tokens a call is about eight calls a minute, and a Match is up
 * to 40 Decision Points. Left unpaced, the run issues them as fast as the network
 * answers -- roughly one a second -- and spends the minute's allowance in eight
 * calls. The adapter handles the resulting 429 exactly as designed (surface a
 * signal, back off once, record a Parse Failure with the 429 body as the raw
 * response), but a log whose decisions are mostly rate-limit bodies is not a
 * fight between two models. The pacing is a property of *this generator's*
 * transport, which is what `AgentDeps.fetch` is for; `packages/providers` is
 * untouched, `assertFreeTierEndpoint` is untouched, and INV-8's ceiling is
 * respected rather than raised.
 *
 * One chain per Deployment, not one for the run: Groq meters TPM per model, so
 * two models have two independent allowances and a shared chain would halve both.
 * `runMatch` awaits both sides together and nothing in a Command Log depends on
 * when a call happened, so serialising one side's calls cannot change the
 * document (INV-1).
 */
function createPacedFetch(minGapMs: number, inner: HttpFetch): HttpFetch {
  // Closure state on the returned function. The chain is the queue: each call
  // waits for its predecessor to have finished *and* for the gap to have elapsed.
  const chain: { tail: Promise<void> } = { tail: Promise.resolve() };

  return (url, init) => {
    const ready = chain.tail;
    chain.tail = ready.then(() => new Promise<void>((resolve) => setTimeout(resolve, minGapMs)));
    return ready.then(() => inner(url, init));
  };
}

/**
 * The gap this Deployment's own free-tier row implies.
 *
 * Derived from `free-tier.config.json` rather than written down, so a model whose
 * published TPM changes paces itself correctly with no edit here -- the same
 * reason the allowlist is data in the first place (Story 3.2's AC5).
 */
function gapForModel(provider: 'groq' | 'cerebras' | 'google-ai-studio', model: string): number {
  const limits = freeTierLimitsFor(provider, model, loadFreeTierConfig());
  const perMinute = Math.max(1, Math.floor(limits.tokensPerMinute / ESTIMATED_TOKENS_PER_CALL));
  return Math.max(MIN_CALL_GAP_MS, Math.ceil(60_000 / perMinute));
}

/**
 * `adoptReporter` mirrors `packages/cli/src/main.ts` exactly, and for its reason:
 * once a guarded io exists, *every* failure must be reported through it. A
 * provider that echoed a request back in an error body would otherwise put the
 * key on stderr from inside `groq.ts`'s non-2xx throw, which is precisely the
 * path `secrets.ts` exists to close. Errors reachable before that line -- a bad
 * config, an unset key -- provably carry no key, because `resolveApiKey` names
 * the environment variable and never its value.
 */
async function main(adoptReporter: (guarded: CliIo) => void): Promise<number> {
  const io = createNodeIo();

  const config = await loadRunConfig(io, CONFIG_PATH);

  const deployments = config.agents.filter((agent) => agent.kind === 'deployment');
  if (deployments.length !== 2) {
    io.err(
      `build-exhibition-replay: ${CONFIG_PATH} declares ${String(deployments.length)} Deployments; ` +
        `this story ships one Match between exactly two. A Baseline Bot on either side is what the ` +
        `existing corpus already has.`,
    );
    return 2;
  }

  // Resolved before anything is planned or played, and this is the line the
  // no-key acceptance criterion is about: `resolveApiKey` throws naming the
  // environment variable and never its value, so the message below is safe to
  // print through the *unguarded* io -- there is no secret yet to redact.
  const secrets = secretsFor(config, io);
  const guarded = guardSecrets(io, secrets);
  adoptReporter(guarded);

  for (const warning of tournamentWarnings(config)) {
    guarded.err(`warning: ${warning}`);
  }

  const agentIds: readonly [string, string] = [deployments[0].id, deployments[1].id];
  const planned = planMatch(config.seedBase, agentIds);

  const env = createFighterEnvironment();
  const quota = createQuotaTracker();
  const transport = defaultHttpFetch();

  const built = [0, 1].map((index) => {
    const agentIndex = index as 0 | 1;
    const agentConfig = agentConfigById(config, agentIds[agentIndex]);
    if (agentConfig.kind !== 'deployment') {
      throw new Error(`build-exhibition-replay: "${agentConfig.id}" is not a Deployment.`);
    }
    const gap = gapForModel(agentConfig.provider, agentConfig.model);
    guarded.out(
      `${agentConfig.id}: ${agentConfig.model} paced at one call every ${String(gap)}ms ` +
        `(${String(freeTierLimitsFor(agentConfig.provider, agentConfig.model, loadFreeTierConfig()).tokensPerMinute)} TPM ` +
        `/ ~${String(ESTIMATED_TOKENS_PER_CALL)} tokens a call)`,
    );
    const deps: AgentDeps = {
      io: guarded,
      fetch: createPacedFetch(gap, transport),
      quota,
      onRateLimit: (signal) => {
        guarded.err(
          `rate limit: ${signal.provider} ${signal.model} -- retry after ${String(signal.retryAfterMs)}ms`,
        );
      },
    };
    return buildAgent(agentConfig, planned.seed, agentIndex, deps);
  });

  guarded.out(`playing ${planned.matchId} (seed ${String(planned.seed)}): ${agentIds.join(' vs ')}`);

  const match = await runMatch(env, [built[0].agent, built[1].agent], planned.seed);

  // `buildArcadeCommandLog` rather than `buildCommandLog`: this story ships a v2
  // document. `AgentIdentity` is assignable to `AgentIdentityV2` -- v2 only widens
  // `kind` -- so the identities `buildAgent` produced travel unchanged, including
  // the `deployment` block it took from the *client* rather than the config, which
  // is what makes the log record the endpoint that actually served every call
  // (INV-6).
  const { buildArcadeCommandLog } = await import('../src/arcade/log');
  const inlineLog: CommandLogV2 = buildArcadeCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed: planned.seed,
    configHash: cliConfigHash(),
    agents: [built[0].identity as AgentIdentityV2, built[1].identity as AgentIdentityV2],
  });

  const split = splitReasoningV2(inlineLog, EXHIBITION_SIDECAR_NAME);

  // Validated before either file is written. The corpus is the artefact and an
  // invalid one must never reach disk (the arcade writer does not self-validate;
  // here we do, exactly as `build-spectate-manifest.mts` does).
  validateCommandLogV2(split.log);

  if (split.log.matchId !== planned.matchId) {
    throw new Error(
      `build-exhibition-replay: planned matchId ${planned.matchId} but the Match produced ` +
        `${split.log.matchId}. The plan and the runner disagree about the Match's inputs.`,
    );
  }

  // Through the guarded io, so a document carrying an API key is refused rather
  // than written -- both the contents and the path are checked.
  await guarded.ensureDir(OUT_DIR);
  await guarded.writeFile(`${OUT_DIR}/${EXHIBITION_LOG_NAME}`, `${JSON.stringify(split.log, null, 2)}\n`);
  await guarded.writeFile(
    `${OUT_DIR}/${EXHIBITION_SIDECAR_NAME}`,
    `${JSON.stringify(split.sidecar, null, 2)}\n`,
  );

  const withReasoning = split.sidecar.entries.filter(
    (entry) => entry.reasoning !== null && entry.reasoning.length > 0,
  ).length;
  const failures = split.log.decisions.filter((decision) => decision.parseFailure === true).length;
  const specials = split.log.decisions.filter((decision) => decision.action === 'special').length;
  const lowestBank = split.log.decisions.reduce(
    (lowest, decision) => Math.min(lowest, decision.bankRemaining ?? lowest),
    Number.MAX_SAFE_INTEGER,
  );

  guarded.out(
    `${EXHIBITION_LOG_NAME}: ${String(split.log.decisions.length)} decisions, ` +
      `${String(withReasoning)} with reasoning text, ${String(failures)} Parse Failure(s), ` +
      `${String(specials)} Ultimate(s), bank floor ${String(lowestBank)} of ` +
      `${String(split.log.tokenBankStart ?? 0)}, ${split.log.result.outcome} by ` +
      `${split.log.result.endReason} at tick ${String(split.log.result.endTick)}`,
  );
  guarded.out(`${EXHIBITION_SIDECAR_NAME}: ${String(split.sidecar.entries.length)} entries`);

  return 0;
}

const reporter: { io: CliIo } = { io: createNodeIo() };

try {
  process.exitCode = await main((guarded) => {
    reporter.io = guarded;
  });
} catch (error) {
  reporter.io.err(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
