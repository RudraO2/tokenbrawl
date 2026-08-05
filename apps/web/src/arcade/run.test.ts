import { describe, expect, it } from 'vitest';
import { ACTIONS, type Action } from '@tokenbrawl/contracts';
import { validateCommandLogV2 } from '../../../../packages/core/src/command-log-v2';
import { defaultKeyMap, runArcadeMatch, type ArcadeMatchHandle } from './run';

/**
 * Story 9.2, integration: a whole Human-vs-Baseline-Bot Match, headless.
 *
 * No real timers and no DOM -- a scripted sequence of mapped inputs is fed to
 * the running Match on a microtask cadence, standing in for a visitor's own
 * keydowns. `feedInput` is a no-op whenever the human is not the one waiting
 * (mid-Commitment-Window, or already answered this Decision Point), so the
 * loop just keeps offering a rotating key and lets `createHumanAgent`'s own
 * clamp decide what reaches `decide()`.
 */

const KEYS = ['ArrowRight', 'z', 'x', 'c', 'ArrowLeft'] as const;

/** Every key in `KEYS` maps to a distinct Action, so the rotation covers the grammar. */
function driveToTerminal(handle: ArcadeMatchHandle, maxTicks = 5_000): Promise<void> {
  let settled = false;
  void handle.log.then(() => {
    settled = true;
  });

  return (async () => {
    let index = 0;
    let iterations = 0;
    while (!settled && iterations < maxTicks) {
      handle.feedInput(KEYS[index % KEYS.length]);
      index += 1;
      iterations += 1;
      // Yields to the microtask queue so a resolved decide() can carry
      // runMatch's loop forward before the next input is offered.
      await Promise.resolve();
    }
  })();
}

describe('a whole Match runs against a scripted human, headless', () => {
  it('reaches a terminal state and produces a valid CommandLogV2', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    expect(() => validateCommandLogV2(log)).not.toThrow();
    expect(log.schemaVersion).toBe('2.0.0');
    expect(log.decisions.length).toBeGreaterThan(0);
    expect(['p1', 'p2', 'draw']).toContain(log.result.outcome);
  });

  it('marks the human side kind: "human" and the other side kind: "bot"', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    expect(log.agents[0].kind).toBe('human');
    expect(log.agents[1].kind).toBe('bot');
  });

  it('plays the human on side 1 when configured that way', async () => {
    const handle = runArcadeMatch({ seed: 4_602, humanSide: 1, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    expect(log.agents[0].kind).toBe('bot');
    expect(log.agents[1].kind).toBe('human');
  });

  it('writes zero token fields for every decision on either side', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    for (const entry of log.decisions) {
      expect(entry.tokensSpent).toBeUndefined();
      expect(entry.reasoningTokens).toBeUndefined();
      expect(entry.bankRemaining).toBeUndefined();
      expect(entry.reflexMode).toBeUndefined();
    }
  });

  it('only ever logs an Action the human actually fed it, for the human side', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    const fedActions = new Set<Action>(KEYS.map((key) => defaultKeyMap(key)).filter((a): a is Action => a !== null));
    for (const entry of log.decisions) {
      if (entry.agentIndex === 0) {
        expect([...fedActions, 'stand']).toContain(entry.action);
      }
    }
  });

  it('ignores an unmapped key mid-Match without ever crashing the Match', async () => {
    const handle = runArcadeMatch({
      seed: 4_601,
      humanSide: 0,
      mapInput: (raw) => (raw === 'Escape' ? null : defaultKeyMap(raw)),
    });

    let settled = false;
    void handle.log.then(() => {
      settled = true;
    });

    let iterations = 0;
    while (!settled && iterations < 5_000) {
      // Interleave a dead key with the legal rotation; the Match must still
      // finish, since the dead key is dropped rather than blocking anything.
      handle.feedInput('Escape');
      handle.feedInput(KEYS[iterations % KEYS.length]);
      iterations += 1;
      await Promise.resolve();
    }

    const log = await handle.log;
    expect(() => validateCommandLogV2(log)).not.toThrow();
  });

  it('never lets an out-of-grammar action reach a decision entry', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    const grammar = new Set<string>([...ACTIONS, 'stand']);
    for (const entry of log.decisions) {
      expect(grammar.has(entry.action)).toBe(true);
    }
  });
});
