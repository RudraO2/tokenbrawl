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

  const agents: [Agent, Agent] =
    humanIndex === 0 ? [humanAgent, botAgent] : [botAgent, humanAgent];

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

/** `mapInput` for a keyboard, exported so the panel and a test share one grammar. */
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
      return 'special';
    default:
      return null;
  }
}
