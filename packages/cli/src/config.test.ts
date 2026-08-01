import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ID_PATTERN,
  DEFAULT_OUTPUT_DIR,
  agentConfigById,
  loadRunConfig,
  parseRunConfig,
  tournamentWarnings,
} from './config';
import { createMemoryIo } from './testing/memory-io';

const HERE = dirname(fileURLToPath(import.meta.url));

const BOTS = [
  { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
  { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
];

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ seedBase: 4101, seedCount: 2, agents: BOTS, ...overrides });
}

describe('parseRunConfig', () => {
  it('accepts a minimal bot-only config and defaults the output directory', () => {
    const parsed = parseRunConfig(config());
    expect(parsed.seedBase).toBe(4101);
    expect(parsed.seedCount).toBe(2);
    expect(parsed.outputDir).toBe(DEFAULT_OUTPUT_DIR);
    expect(parsed.tokenBankStart).toBeUndefined();
    expect(parsed.agents).toHaveLength(2);
  });

  it('defaults a Deployment to ranked', () => {
    const parsed = parseRunConfig(
      config({
        agents: [
          BOTS[0],
          {
            id: 'groq:one',
            kind: 'deployment',
            provider: 'groq',
            model: 'openai/gpt-oss-20b',
            apiKeyEnv: 'GROQ_API_KEY',
          },
        ],
      }),
    );
    const deployment = agentConfigById(parsed, 'groq:one');
    expect(deployment.kind).toBe('deployment');
    expect(deployment.kind === 'deployment' && deployment.ranked).toBe(true);
  });

  it('rejects a document that is not JSON', () => {
    expect(() => parseRunConfig('{')).toThrow(/not valid JSON/);
  });

  it('rejects a seed range that runs past the frozen schema maximum', () => {
    expect(() => parseRunConfig(config({ seedBase: 4_294_967_295, seedCount: 2 }))).toThrow(
      /runs past the maximum seed/,
    );
  });

  it('rejects a non-integer or negative seedBase', () => {
    expect(() => parseRunConfig(config({ seedBase: 1.5 }))).toThrow(/seedBase/);
    expect(() => parseRunConfig(config({ seedBase: -1 }))).toThrow(/seedBase/);
  });

  it('rejects a seedCount of zero -- a run with nothing in it is a typo', () => {
    expect(() => parseRunConfig(config({ seedCount: 0 }))).toThrow(/seedCount/);
  });

  it('rejects fewer than two agents', () => {
    expect(() => parseRunConfig(config({ agents: [BOTS[0]] }))).toThrow(/at least 2 entries/);
  });

  it('rejects duplicate agent ids -- they would collide matchIds and break resume', () => {
    expect(() => parseRunConfig(config({ agents: [BOTS[0], BOTS[0]] }))).toThrow(/share the id/);
  });

  it('rejects an unknown bot kind', () => {
    expect(() =>
      parseRunConfig(config({ agents: [BOTS[0], { id: 'b', kind: 'bot', bot: 'genius' }] })),
    ).toThrow(/bot must be one of/);
  });

  it('rejects an unknown agent kind', () => {
    expect(() => parseRunConfig(config({ agents: [BOTS[0], { id: 'b', kind: 'robot' }] }))).toThrow(
      /kind must be/,
    );
  });

  it('rejects a provider the CLI does not serve', () => {
    for (const provider of ['openrouter', 'byok', 'xai']) {
      expect(() =>
        parseRunConfig(
          config({
            agents: [
              BOTS[0],
              { id: 'x', kind: 'deployment', provider, model: 'm', apiKeyEnv: 'K' },
            ],
          }),
        ),
      ).toThrow(/provider must be one of/);
    }
  });

  it('rejects an apiKeyEnv that is a key rather than a variable name (AC3)', () => {
    // One per provider's real key shape. `gsk_live_...` is the interesting one:
    // it is legal in a permissive `[A-Za-z_][A-Za-z0-9_]*` variable pattern, so
    // only the SCREAMING_SNAKE_CASE rule catches it.
    for (const pasted of ['gsk_live_0123456789abcdef', 'csk-0123456789abcdef', 'AIzaSyDabcdef0123']) {
      expect(() =>
        parseRunConfig(
          config({
            agents: [
              BOTS[0],
              { id: 'x', kind: 'deployment', provider: 'groq', model: 'm', apiKeyEnv: pasted },
            ],
          }),
        ),
      ).toThrow(/NAME of an environment variable/);
    }
  });

  it('has no field a key could be written into at all', () => {
    const parsed = parseRunConfig(
      config({
        agents: [
          BOTS[0],
          {
            id: 'groq:one',
            kind: 'deployment',
            provider: 'groq',
            model: 'm',
            apiKeyEnv: 'GROQ_API_KEY',
            // A hopeful operator putting the key in the config: the parser
            // keeps only the fields it declares, so it does not survive.
            apiKey: 'gsk_live_0123456789abcdef',
          },
        ],
      }),
    );
    expect(JSON.stringify(parsed)).not.toContain('gsk_live');
  });
});

describe('the frozen Agent id pattern (AD-3, and the ledger constraint from 4.7)', () => {
  it('is the same pattern the frozen schema states', () => {
    const schema = JSON.parse(
      readFileSync(join(HERE, '..', '..', '..', 'docs', 'contracts', 'command-log.schema.json'), 'utf8'),
    ) as { $defs: { agentIdentity: { properties: { id: { pattern: string } } } } };
    expect(AGENT_ID_PATTERN.source).toBe(schema.$defs.agentIdentity.properties.id.pattern);
  });

  it('rejects a config id carrying a slash, as a model name routinely does', () => {
    expect(() =>
      parseRunConfig(config({ agents: [BOTS[0], { id: 'openai/gpt-oss-120b', kind: 'bot', bot: 'random' }] })),
    ).toThrow(/frozen Agent id pattern/);
  });

  it('rejects an uppercase id', () => {
    expect(() => parseRunConfig(config({ agents: [BOTS[0], { id: 'Bot', kind: 'bot', bot: 'random' }] }))).toThrow(
      /frozen Agent id pattern/,
    );
  });

  it('rejects an id longer than 96 characters', () => {
    const long = 'a'.repeat(97);
    expect(() => parseRunConfig(config({ agents: [BOTS[0], { id: long, kind: 'bot', bot: 'random' }] }))).toThrow(
      /frozen Agent id pattern/,
    );
  });
});

describe('tournament rules (Story 3.3 AC2/AC4, finally with a caller)', () => {
  it('throws on an OpenRouter Deployment before it can reach validateTournamentConfig', () => {
    // The CLI's own provider list refuses it first, which is the same answer
    // one step earlier and with a better message.
    expect(() =>
      parseRunConfig(
        config({
          agents: [
            BOTS[0],
            { id: 'or', kind: 'deployment', provider: 'openrouter', model: 'm', apiKeyEnv: 'K' },
          ],
        }),
      ),
    ).toThrow(/provider must be one of/);
  });

  it('warns, without failing, about two ranked Deployments on one provider', () => {
    const parsed = parseRunConfig(
      config({
        agents: [
          { id: 'groq:a', kind: 'deployment', provider: 'groq', model: 'a', apiKeyEnv: 'GROQ_API_KEY' },
          { id: 'groq:b', kind: 'deployment', provider: 'groq', model: 'b', apiKeyEnv: 'GROQ_API_KEY' },
        ],
      }),
    );
    const warnings = tournamentWarnings(parsed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/groq.*2 ranked Deployments/);
  });

  it('does not warn when the second Deployment is unranked', () => {
    const parsed = parseRunConfig(
      config({
        agents: [
          { id: 'groq:a', kind: 'deployment', provider: 'groq', model: 'a', apiKeyEnv: 'GROQ_API_KEY' },
          {
            id: 'groq:b',
            kind: 'deployment',
            provider: 'groq',
            model: 'b',
            apiKeyEnv: 'GROQ_API_KEY',
            ranked: false,
          },
        ],
      }),
    );
    expect(tournamentWarnings(parsed)).toStrictEqual([]);
  });
});

describe('loadRunConfig and agentConfigById', () => {
  it('reads through the io port', async () => {
    const io = createMemoryIo({ files: { 'run.json': config({ outputDir: 'out' }) } });
    expect((await loadRunConfig(io, 'run.json')).outputDir).toBe('out');
  });

  it('lists the declared ids when asked for one that is not there', () => {
    const parsed = parseRunConfig(config());
    expect(() => agentConfigById(parsed, 'nope')).toThrow(/bot:aggressive, bot:spacing/);
  });
});
