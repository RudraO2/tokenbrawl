import type { CommandLogV2 } from '@tokenbrawl/contracts';
import { computeConfigHash } from '../../../../packages/core/src/command-log';
import { createDeployment } from '../../../../packages/core/src/deployment';
import type { ProviderClient, ProviderRequest, ProviderResponse } from '../../../../packages/core/src/deployment';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildArcadeCommandLog } from '../arcade/log';
import type { ReasoningSidecar } from '../replay/sidecar';
import { splitReasoningV2 } from './sidecar-split';

/**
 * Story 12.12: the fixture the player is proven against before a key exists.
 *
 * **What this is not.** It is not a replay, it is not shipped under
 * `apps/web/public/replays/`, and nothing a visitor can reach ever mounts it.
 * The story's standing rule is explicit that "a stubbed model response presented
 * as a real one" is worse than no replay at all, so this document lives in
 * `src/testing/` beside `demo-log.ts` -- Node-only, outside the bundle -- and its
 * only consumers are the tests in `exhibition-fixture.test.ts` and the panel and
 * bank assertions that ride on them.
 *
 * **What it is for.** Four acceptance criteria of this story are statements about
 * how the *player* renders a Deployment-vs-Deployment log: hover reasoning shows
 * real text, the Decision Point shows its `provider` and `endpoint`, the Token
 * Bank HUD draws a real budget, and a Parse Failure reads as a Parse Failure.
 * Every one of those paths shipped untested against real data, because every
 * committed log is two Baseline Bots with `reasoning: null` on all 379
 * submissions. A fixture is what lets those four be asserted without a network
 * call, and without waiting on a key.
 *
 * **Why it goes through the real Deployment path.** The obvious way to build a
 * document like this is to hand-write the JSON. That would test the renderer
 * against a shape nobody produces: `runMatch` decides `bankRemaining`,
 * `debitTokenBank` decides what a reported `tokensSpent` costs, `parseAction`
 * decides what a Parse Failure is, and `buildArcadeCommandLog` decides which
 * fields a Deployment entry carries. So the fixture drives all four -- a real
 * `createDeployment` over a scripted `ProviderClient` -- and the only thing
 * faked is the HTTP call itself. What the tests then read is the log the shipped
 * writers actually emit.
 */

/** The seed. Fixed, so the fixture is one document rather than a family of them. */
export const EXHIBITION_FIXTURE_SEED = 771_203;

/**
 * The endpoint the scripted responses claim to have come from.
 *
 * Groq's real allowlisted free-tier endpoint, taken verbatim from
 * `packages/providers/src/free-tier.config.json`. Not decoration: the panel
 * assertion is that a Decision Point *displays* its endpoint, and a placeholder
 * like `https://example.test/` would let the display pass while telling a reader
 * nothing about the shape it has to render (a long path that has to wrap).
 */
export const EXHIBITION_FIXTURE_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export const EXHIBITION_FIXTURE_PROVIDER = 'groq';

/** Sidecar path recorded in the fixture log's `reasoningSidecar`. */
export const EXHIBITION_FIXTURE_SIDECAR_PATH = 'exhibition-fixture.reasoning.json';

/**
 * The Decision Point index, within one Agent's own call sequence, whose scripted
 * response fails to parse.
 *
 * Sixth call rather than first: a failure on the opening call would be the only
 * entry either side had, and the AC asks that a Parse Failure read as one
 * *within* a Match that is otherwise fine. Kept on agent 1 alone, so a test can
 * assert that agent 0's entry at the same tick did not fail.
 */
export const EXHIBITION_FIXTURE_FAILURE_CALL = 5;

/**
 * What one scripted call reports.
 *
 * `reasoning` and `text` are both filled, and they are different strings on
 * purpose: Groq returns a reasoning model's deliberation in `message.reasoning`
 * and its answer in `message.content`, and `openai-wire.ts` maps them to two
 * separate fields. A fixture that put the same string in both would not
 * distinguish "the panel shows the reasoning" from "the panel shows the raw
 * response", which is exactly the distinction this story's gate check turns on.
 */
interface ScriptedCall {
  readonly reasoning: string;
  readonly text: string;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
}

/**
 * Six deliberations, cycled.
 *
 * Written as a fighter would actually think about this Environment -- distance,
 * commitment, meter -- rather than as lorem ipsum, because a human reads these
 * in the panel and a fixture whose text is obviously filler makes the capture
 * useless as evidence that the panel is legible.
 */
const SCRIPT: readonly ScriptedCall[] = Object.freeze([
  {
    reasoning:
      'Distance is 320 units and neither of us is committed, so an attack now would whiff and leave me open for the whole recovery. Closing is free.',
    text: 'Closing the gap first.\nACTION: advance',
    completionTokens: 148,
    reasoningTokens: 96,
  },
  {
    reasoning:
      'Still out of range. My meter is under half, so the Ultimate is not on the menu and there is nothing to save for. Keep walking in.',
    text: 'ACTION: advance',
    completionTokens: 131,
    reasoningTokens: 88,
  },
  {
    reasoning:
      'In range now, and the opponent has committed: the readout says several Ticks of their commitment remain, which is the safest thing to hit in this game. Swing.',
    text: 'Punishing the commitment.\nACTION: attack',
    completionTokens: 164,
    reasoningTokens: 104,
  },
  {
    reasoning:
      'They are in range of me too and I have no commitment left to hide behind. Blocking costs me nothing this Decision Point and halves what a trade costs.',
    text: 'ACTION: block',
    completionTokens: 122,
    reasoningTokens: 74,
  },
  {
    reasoning:
      'That block ate the trade. Backing off resets the spacing and buys a Decision Point of meter without giving them a free swing at me.',
    text: 'ACTION: retreat',
    completionTokens: 139,
    reasoningTokens: 81,
  },
  {
    reasoning:
      'Close again, both of us neutral. An attack here is a coin flip; advance one more step and I am inside my own range and outside theirs.',
    text: 'ACTION: advance',
    completionTokens: 127,
    reasoningTokens: 79,
  },
]);

/**
 * The one response that does not parse.
 *
 * A model that reasoned perfectly well and then ended on prose instead of the
 * grammar's final line. That is what a real Parse Failure looks like -- not
 * garbage, not an error body -- and `parseAction` reads the last line containing
 * a letter, finds `next.` rather than an Action, and returns `null`. `runMatch`
 * turns that into the Fallback Action `stand` with `parseFailure: true`, and the
 * frozen schema requires the `rawResponse` to stay on the entry so the failure
 * is auditable (Story 1.6).
 */
const FAILING_CALL: ScriptedCall = Object.freeze({
  reasoning:
    'They are mid-commitment and I could punish it, but my meter is one Decision Point from full and an Ultimate lands for three times as much. I will hold.',
  text: 'I will hold this Decision Point and see what they do next.',
  completionTokens: 156,
  reasoningTokens: 102,
});

/**
 * A `ProviderClient` that answers from `SCRIPT` instead of from the network.
 *
 * The call counter is closure state on the returned client, not a module-level
 * binding: two clients in one Match must be two independent sequences, and
 * `source-discipline.test.ts` bans the module-level form outright (this file is
 * exempt as `src/testing/`, but writing it the banned way here is how the pattern
 * gets copied into a file that is not).
 *
 * `request` is accepted and deliberately unread beyond its Reflex-Mode cap. The
 * fixture must not become a second prompt assembler (INV-7): nothing here may
 * key a response off what the Scaffold said.
 */
function createScriptedClient(options: {
  readonly model: string;
  readonly failAtCall: number | null;
}): ProviderClient {
  const state = { calls: 0 };

  return Object.freeze({
    provider: 'groq' as const,
    endpoint: EXHIBITION_FIXTURE_ENDPOINT,
    model: options.model,
    complete: (request: ProviderRequest): Promise<ProviderResponse> => {
      const call = state.calls;
      state.calls += 1;
      const scripted =
        options.failAtCall !== null && call === options.failAtCall
          ? FAILING_CALL
          : SCRIPT[call % SCRIPT.length];

      // Reflex Mode is the one thing about the request a scripted client may
      // read, because it is a *cap* rather than a prompt: a bare-word reply is
      // the only honest answer to a call served at eight tokens, and a fixture
      // that reasoned for 148 tokens under an 8-token cap would be describing
      // something no provider can do.
      if (request.maxTokens !== undefined) {
        return Promise.resolve({
          text: 'block',
          usage: { tokensSpent: 3, reasoningTokens: null, cachedTokens: null },
          reasoning: null,
        });
      }

      return Promise.resolve({
        text: scripted.text,
        usage: {
          tokensSpent: scripted.completionTokens,
          reasoningTokens: scripted.reasoningTokens,
          cachedTokens: null,
        },
        reasoning: scripted.reasoning,
      });
    },
  });
}

export interface ExhibitionFixture {
  /** The log as it would be published: reasoning externalised, `reasoningSidecar` set. */
  readonly log: CommandLogV2;
  /** The same log with its reasoning still inline, for the `inline` reader state. */
  readonly inlineLog: CommandLogV2;
  readonly sidecar: ReasoningSidecar;
}

/**
 * Builds the fixture. Deterministic: same output every call, no network, no clock.
 *
 * Async because `runMatch` is -- the Harness awaits both Agents' `decide` calls
 * together, and a scripted client that resolved synchronously would still be
 * awaited. Every test that uses this awaits it once.
 */
export async function buildExhibitionFixture(): Promise<ExhibitionFixture> {
  const env = createFighterEnvironment();

  const p1 = createDeployment({
    id: 'groq:llama-3.3-70b-versatile',
    client: createScriptedClient({ model: 'llama-3.3-70b-versatile', failAtCall: null }),
  });
  const p2 = createDeployment({
    id: 'groq:openai-gpt-oss-120b',
    client: createScriptedClient({
      model: 'openai/gpt-oss-120b',
      failAtCall: EXHIBITION_FIXTURE_FAILURE_CALL,
    }),
  });

  const match = await runMatch(env, [p1, p2], EXHIBITION_FIXTURE_SEED);

  const inlineLog = buildArcadeCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed: EXHIBITION_FIXTURE_SEED,
    configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
    agents: [
      {
        id: p1.id,
        kind: 'deployment',
        deployment: {
          provider: 'groq',
          endpoint: EXHIBITION_FIXTURE_ENDPOINT,
          model: 'llama-3.3-70b-versatile',
          meteringProbe: 'reports-reasoning',
        },
        track: 'main',
      },
      {
        id: p2.id,
        kind: 'deployment',
        deployment: {
          provider: 'groq',
          endpoint: EXHIBITION_FIXTURE_ENDPOINT,
          model: 'openai/gpt-oss-120b',
          meteringProbe: 'reports-reasoning',
        },
        track: 'main',
      },
    ],
  });

  const split = splitReasoningV2(inlineLog, EXHIBITION_FIXTURE_SIDECAR_PATH);

  return { log: split.log, inlineLog, sidecar: split.sidecar };
}
