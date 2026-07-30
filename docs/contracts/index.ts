/**
 * Tokenbrawl frozen contracts.
 *
 * Every package binds to this file. Widening anything here silently breaks
 * every parallel agent building against it — if a story appears to require a
 * change, stop and escalate rather than editing.
 *
 * Companion: ./command-log.schema.json is the wire format. These types and
 * that schema must agree; a test asserts it.
 */

export const SCHEMA_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The five Actions an Agent may choose. */
export type Action = 'advance' | 'retreat' | 'attack' | 'block' | 'special';

/**
 * `stand` is the Fallback Action applied on a Parse Failure. An Agent may
 * never choose it — it exists so that failing to follow the format is never
 * accidentally rewarded, as `block` (safe) or a repeated attack could be.
 */
export type LoggedAction = Action | 'stand';

export const ACTIONS: readonly Action[] = ['advance', 'retreat', 'attack', 'block', 'special'];
export const FALLBACK_ACTION = 'stand' as const;

// ---------------------------------------------------------------------------
// Agent port
// ---------------------------------------------------------------------------

/** What an Agent is told. Produced by the Environment Adapter, never by the Agent. */
export interface Observation {
  /** Serialised game state. Adapter-owned format; opaque to the Harness. */
  readonly state: string;
  /** Actions currently legal. An Agent inside a Commitment Window is not polled at all. */
  readonly legalActions: readonly Action[];
  /** Simulation Tick of this Decision Point. Ticks, never seconds. */
  readonly tick: number;
}

/**
 * The prompt sent to a Deployment. Assembled by the Harness from the
 * Scaffold plus the Observation — never by a provider adapter, and never
 * varied per Deployment (INV-7).
 */
export interface Prompt {
  readonly system: string;
  readonly user: string;
  /** Token Bank remaining, surfaced to the Agent so scarcity is playable. */
  readonly budgetRemaining: number;
  /** True once the Token Bank is empty: caller must send max_tokens=8. */
  readonly reflexMode: boolean;
}

/** What an Agent returns. Token counts are reported, never trusted blindly. */
export interface Decision {
  readonly action: Action | null;
  /**
   * Completion tokens actually consumed, including reasoning tokens where the
   * provider reports them. `null` means the provider reported no usage — a
   * probe result, never to be coerced to zero.
   */
  readonly tokensSpent: number | null;
  readonly reasoningTokens: number | null;
  readonly reasoning: string | null;
  readonly rawResponse: string;
  readonly provider: string;
  readonly endpoint: string;
}

/**
 * The Agent port. The Harness blocks on `decide` with no timeout-driven
 * default action — a Deployment taking 40 seconds and one taking 200ms must
 * produce identical Command Logs (INV-1).
 */
export interface Agent {
  readonly id: string;
  readonly kind: 'deployment' | 'bot';
  observe(observation: Observation, budgetRemaining: number, reflexMode: boolean): Prompt;
  decide(prompt: Prompt): Promise<Decision>;
}

// ---------------------------------------------------------------------------
// Environment port
// ---------------------------------------------------------------------------

/**
 * The Environment Adapter port. Nothing game-specific may appear here — this
 * interface is the proof that the Harness is environment-agnostic, and
 * MicroRTS must later slot in without the Harness changing.
 *
 * Implementations MUST be deterministic: fixed timestep, integer-only state,
 * seeded PRNG threaded through state rather than read from a global, and
 * deterministic iteration order over every collection that can affect state.
 */
export interface EnvironmentAdapter<TState> {
  readonly id: string;
  readonly version: string;

  /** Construct initial state from a seed. Pure: same seed, same state. */
  reset(seed: number): TState;

  /** Whether this Agent is actionable at this Tick (i.e. not mid-Commitment-Window). */
  isActionable(state: TState, agentIndex: 0 | 1): boolean;

  /** Adapter-owned serialisation of what this Agent can see. */
  observe(state: TState, agentIndex: 0 | 1): Observation;

  /**
   * Advance one Decision Point. Both Actions are applied simultaneously —
   * neither Agent's choice may influence the other's for the same Tick.
   * `null` means the Agent was not actionable and submitted nothing.
   */
  step(state: TState, actions: readonly [LoggedAction | null, LoggedAction | null]): TState;

  /** Ticks the simulation advances per Decision Point boundary. */
  readonly ticksPerDecision: number;

  /** Hard cap on Match length in Ticks. */
  readonly maxTicks: number;

  terminal(state: TState): TerminalResult | null;

  /**
   * SHA-256 over a canonical serialisation of state: keys sorted, integers
   * only, no floats. This is the machine expression of INV-2.
   */
  hash(state: TState): string;
}

export interface TerminalResult {
  readonly outcome: 'p1' | 'p2' | 'draw';
  readonly endTick: number;
  readonly endReason: 'ko' | 'timeout';
  readonly healthRemaining: readonly [number, number];
}

// ---------------------------------------------------------------------------
// Command Log
// ---------------------------------------------------------------------------

export type ProviderId = 'groq' | 'cerebras' | 'google-ai-studio' | 'openrouter' | 'xai' | 'byok';

export type MeteringProbeResult =
  | 'reports-reasoning'
  | 'reports-completion-only'
  | 'no-usage-reported';

export interface DeploymentIdentity {
  readonly provider: ProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly meteringProbe?: MeteringProbeResult;
}

export interface AgentIdentity {
  readonly id: string;
  readonly kind: 'deployment' | 'bot';
  readonly deployment?: DeploymentIdentity;
  /** Anything but `reports-reasoning` forces `reflex`; tracks never merge. */
  readonly track?: 'main' | 'reflex';
}

export interface DecisionEntry {
  readonly tick: number;
  readonly agentIndex: 0 | 1;
  readonly action: LoggedAction;
  /**
   * Absent for a Baseline Bot (it consumes nothing). `null` for a Deployment
   * whose provider reported no usage — a Metering Probe result, never to be
   * collapsed to `0`. INV-5 depends on that distinction surviving to disk,
   * so it is carried here exactly as `Decision.tokensSpent` reports it.
   */
  readonly tokensSpent?: number | null;
  /** `null` means the provider did not report reasoning tokens separately. */
  readonly reasoningTokens?: number | null;
  readonly bankRemaining?: number;
  readonly reflexMode?: boolean;
  readonly parseFailure?: boolean;
  readonly reasoning?: string | null;
  readonly rawResponse?: string | null;
  readonly provider?: string;
  readonly endpoint?: string;
}

/**
 * The canonical record of one Match, and the only cross-boundary data format
 * in the system. Stores decisions, not frames: the player reproduces visual
 * state by re-running the deterministic engine from (seed, config, actions).
 */
export interface CommandLog {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly matchId: string;
  readonly environment: { readonly id: string; readonly version: string };
  readonly seed: number;
  readonly configHash: string;
  readonly tokenBankStart?: number;
  readonly agents: readonly [AgentIdentity, AgentIdentity];
  readonly decisions: readonly DecisionEntry[];
  readonly result: TerminalResult;
  readonly finalStateHash: string;
  readonly reasoningSidecar?: string | null;
}

/**
 * Exact-match version check. A consumer that does not implement this precise
 * version MUST reject the document — a partial read of an evolved schema is
 * how a leaderboard quietly becomes wrong.
 */
export function assertSchemaVersion(log: { schemaVersion?: unknown }): asserts log is CommandLog {
  if (log.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Command Log schemaVersion: ${String(log.schemaVersion)} (expected ${SCHEMA_VERSION})`,
    );
  }
}
