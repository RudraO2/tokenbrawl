import type { Action, Agent, AgentIdentityV2, CommandLogV2 } from '@tokenbrawl/contracts';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import {
  createAggressiveBot,
  createRandomBot,
  createSpacingBot,
} from '../../../../packages/env-fighter/src/bots';
import { createHumanAgent, type InputMapper } from './agent';
import { arcadeConfigHash, buildArcadeCommandLog } from './log';

/**
 * Story 9.2: one Match, a visitor against a Baseline Bot, played out in their
 * own tab.
 *
 * Composed exactly the way `byok/run.ts` composes a BYOK Match: unmodified
 * `createFighterEnvironment` + unmodified `runMatch`, differing only in which
 * two Agents are handed to it. No forked simulation path exists here or
 * could -- the Environment and the Harness are the same objects Story 1.2 and
 * Story 2.1 built, with no arcade-specific branch inside either.
 */

/** The frozen schema's `seed` bound. */
const MAX_SEED = 4_294_967_295;

export type BaselineBotKind = 'random' | 'aggressive' | 'spacing';

export interface ArcadeRunConfig {
  readonly seed: number;
  /** Which side the visitor plays. The other side is the Baseline Bot. */
  readonly humanSide: 0 | 1;
  /** Defaults to the random bot, the same default `byok`'s picker opens on. */
  readonly botKind?: BaselineBotKind;
  /** Maps a raw keydown/tap id to an Action; unrecognised input maps to `null`. */
  readonly mapInput: InputMapper;
  /**
   * Story 10.6. Called with the human side's `legalActions` at the start of
   * every Decision Point they are polled on.
   *
   * The panel needs this for one reason: an Arcade Match runs *headlessly*
   * (`startup.ts` re-mounts the player only once it has finished), so while a
   * visitor is playing there is no canvas and therefore no Super Gauge on
   * screen. Without this the player cannot know their bar is full, and AC3's
   * "the panel surfaces the affordance" would have nothing to surface.
   *
   * `legalActions` is the *environment's own* answer -- `legalActionsFor`
   * returns every Action once `meter >= specialMeterCost` and drops `special`
   * below it -- so "does this list contain `special`" is exactly "is the gauge
   * full", read from the simulation rather than recomputed beside it. This is
   * deliberately a report, not a second clamp: `createHumanAgent` is still the
   * one place an input becomes an Action or is dropped (AD-14).
   */
  readonly onLegalActions?: (legalActions: readonly Action[]) => void;
}

export interface ArcadeMatchHandle {
  /** Settles once the Match reaches a terminal state. */
  readonly log: Promise<CommandLogV2>;
  /** Fed by the panel on every keydown/tap; clamped and mapped inside `createHumanAgent`. */
  readonly feedInput: (raw: string) => void;
}

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new Error(`Seed must be a whole number between 0 and ${String(MAX_SEED)}.`);
  }
}

function createBaselineBot(kind: BaselineBotKind, id: string, seed: number): Agent {
  switch (kind) {
    case 'aggressive':
      return createAggressiveBot(id, DEFAULT_FIGHTER_CONFIG);
    case 'spacing':
      return createSpacingBot(id, DEFAULT_FIGHTER_CONFIG);
    case 'random':
    default:
      return createRandomBot(id, seed);
  }
}

/**
 * Starts the Match and returns immediately with a handle to drive it.
 *
 * `log` is a promise rather than an awaited value: the panel needs
 * `feedInput` available *before* the Match can finish, and awaiting here
 * would block on a human player's own input, on a page whose UI depends on
 * having the handle back synchronously.
 */
export function runArcadeMatch(config: ArcadeRunConfig): ArcadeMatchHandle {
  assertSeed(config.seed);

  const env = createFighterEnvironment();
  const botKind = config.botKind ?? 'random';
  const humanIndex = config.humanSide;
  const botIndex: 0 | 1 = humanIndex === 0 ? 1 : 0;

  const humanId = `p${String(humanIndex + 1)}:human`;
  const botId = `p${String(botIndex + 1)}:bot:${botKind}`;

  const { agent: humanAgent, feedInput } = createHumanAgent(humanId, config.mapInput);
  const botAgent = createBaselineBot(botKind, botId, config.seed);

  // Story 10.6. A read-only tee on the human side's `observe`, so the panel can
  // be told what the environment already told the Agent.
  //
  // Wrapped here rather than inside `createHumanAgent` for the reason that
  // file's docblock gives: it is deliberately free of anything host-shaped and
  // owns the clamp alone. This wrapper adds no decision and changes no
  // `Observation` -- it forwards the same object to the same method and passes
  // the list on. A throw from the panel's listener is contained rather than
  // allowed to fail the Decision Point, since a UI callback must not be able to
  // break a Match in progress.
  const watchedHuman: Agent = {
    ...humanAgent,
    observe: (observation, budgetRemaining, reflexMode) => {
      try {
        config.onLegalActions?.(observation.legalActions);
      } catch {
        // A reporting listener that threw. The Match is not its business.
      }
      // Every argument forwarded, including the two `createHumanAgent` chooses
      // not to declare: this wrapper must stay a tee even if that file starts
      // reading them.
      return humanAgent.observe(observation, budgetRemaining, reflexMode);
    },
  };

  const agents: [Agent, Agent] =
    humanIndex === 0 ? [watchedHuman, botAgent] : [botAgent, watchedHuman];

  const identities: readonly [AgentIdentityV2, AgentIdentityV2] =
    humanIndex === 0
      ? [
          { id: humanId, kind: 'human' },
          { id: botId, kind: 'bot' },
        ]
      : [
          { id: botId, kind: 'bot' },
          { id: humanId, kind: 'human' },
        ];

  const log = runMatch(env, agents, config.seed).then((match) =>
    buildArcadeCommandLog(match, {
      environment: { id: env.id, version: env.version },
      seed: config.seed,
      configHash: arcadeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: identities,
    }),
  );

  return { log, feedInput };
}

/**
 * `mapInput` for a keyboard, exported so the panel and a test share one grammar.
 *
 * Story 10.6 adds `L` for the Ultimate, alongside the `C` that Story 9.2 gave
 * `special` and which keeps its meaning exactly. Two keys for one Action rather
 * than a rebind, for two reasons: `C` is the letter this panel has told players
 * to press since 9.2 and silently moving it would break the muscle memory of
 * anyone who has played, and `L` is the key the reference project fires its own
 * super on, so someone moving between the two has one thing less to relearn.
 *
 * `L` is a single dedicated key, not a chord. The reference reaches its super
 * as Light + Heavy + Blast pressed together; this codebase has no chord concept
 * anywhere in its input handling, and a partially-landed chord is precisely the
 * "why didn't my Ultimate come out" complaint the reference's own comments
 * record fighting.
 */
export function defaultKeyMap(raw: string): Action | null {
  switch (raw) {
    case 'ArrowRight':
      return 'advance';
    case 'ArrowLeft':
      return 'retreat';
    case 'z':
    case 'Z':
      return 'attack';
    case 'x':
    case 'X':
      return 'block';
    case 'c':
    case 'C':
    case 'l':
    case 'L':
      return 'special';
    default:
      return null;
  }
}
