import type { CommandLogV2 } from '@tokenbrawl/contracts';
import { SCHEMA_VERSION, SCHEMA_VERSION_V2 } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import commandLogV2Schema from '../../../docs/contracts/command-log.v2.schema.json';
import { sha256Hex } from './canonical-hash';
import { validateCommandLogV2 } from './command-log-v2';

const SEED = 42;

const FIXTURE_MATCH_ID = sha256Hex('v2-fixture-match-id');
const FIXTURE_CONFIG_HASH = sha256Hex('v2-fixture-config-hash');
const FIXTURE_STATE_HASH = sha256Hex('v2-fixture-state-hash');

function baseCommandLogV2(overrides: Partial<CommandLogV2> = {}): CommandLogV2 {
  return {
    schemaVersion: SCHEMA_VERSION_V2,
    matchId: FIXTURE_MATCH_ID,
    environment: { id: 'mock-environment', version: '1.0.0' },
    seed: SEED,
    configHash: FIXTURE_CONFIG_HASH,
    agents: [
      { id: 'bot:p1', kind: 'bot' },
      { id: 'human:p2', kind: 'human' },
    ],
    decisions: [],
    result: { outcome: 'p1', endTick: 3, endReason: 'timeout', healthRemaining: [10, 5] },
    finalStateHash: FIXTURE_STATE_HASH,
    ...overrides,
  };
}

describe('types and schema agree', () => {
  it('SCHEMA_VERSION_V2 matches the v2 schema JSON\'s pinned const', () => {
    expect(SCHEMA_VERSION_V2).toBe(
      (commandLogV2Schema as { properties: { schemaVersion: { const: string } } }).properties
        .schemaVersion.const,
    );
  });

  it('a v2 CommandLog with no new-in-v2 optional fields populated (the ordinary case) validates', () => {
    const log = baseCommandLogV2({
      decisions: [
        {
          tick: 0,
          agentIndex: 0,
          action: 'attack',
        },
        {
          tick: 0,
          agentIndex: 1,
          action: 'block',
        },
      ],
    });

    expect(validateCommandLogV2(log)).toStrictEqual(log);
  });
});

describe('v2 fixture validates (I/O matrix)', () => {
  it('validates a hand-built v2 Command Log with a jump action and verticalPosition/zone/juggleCount', () => {
    const log = baseCommandLogV2({
      decisions: [
        {
          tick: 0,
          agentIndex: 0,
          action: 'jump',
          verticalPosition: 4,
          zone: 'high',
          juggleCount: 2,
        },
        {
          tick: 0,
          agentIndex: 1,
          action: 'attack',
        },
      ],
    });

    expect(validateCommandLogV2(log)).toStrictEqual(log);
  });
});

describe('v1 doc through v2 reader (I/O matrix)', () => {
  it('throws on schema-version mismatch when given a v1-shaped fixture', () => {
    const v1Shaped: unknown = {
      schemaVersion: SCHEMA_VERSION,
      matchId: FIXTURE_MATCH_ID,
      environment: { id: 'mock-environment', version: '1.0.0' },
      seed: SEED,
      configHash: FIXTURE_CONFIG_HASH,
      agents: [
        { id: 'bot:p1', kind: 'bot' },
        { id: 'bot:p2', kind: 'bot' },
      ],
      decisions: [],
      result: { outcome: 'p1', endTick: 3, endReason: 'timeout', healthRemaining: [10, 5] },
      finalStateHash: FIXTURE_STATE_HASH,
    };

    expect(() => validateCommandLogV2(v1Shaped)).toThrow(/1\.0\.0/);
  });
});
