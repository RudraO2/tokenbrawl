import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertFreeTierEndpoint,
  freeTierLimitsFor,
  freeTierProvider,
  loadFreeTierConfig,
} from './free-tier';

/**
 * Story 3.2 AC5 (free-tier limits come from a config file) and INV-8 (a paid
 * endpoint fails configuration validation).
 *
 * Every rejection case runs through the real `loadFreeTierConfig`, which takes
 * the document as a parameter precisely so these can be exercised without
 * corrupting the committed file.
 */

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'free-tier.config.json');

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const VALID_LIMITS = { requestsPerMinute: 30, requestsPerDay: 1000, tokensPerMinute: 6000 };

/** A well-formed document; each rejection case damages exactly one field of it. */
function document(providerOverrides: Record<string, unknown> = {}): unknown {
  return {
    verifiedOn: '2026-08-01',
    providers: {
      groq: {
        endpoints: [GROQ_ENDPOINT],
        fallbackBackoffMs: 60_000,
        maxBackoffMs: 120_000,
        defaults: { ...VALID_LIMITS },
        models: {},
        ...providerOverrides,
      },
    },
  };
}

describe('the free-tier config file (AC5)', () => {
  it('is the source of the limits, and the committed file is what is read', () => {
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
      verifiedOn: string;
      providers: Record<string, { models: Record<string, { requestsPerDay: number }> }>;
    };
    const loaded = loadFreeTierConfig();

    expect(loaded.verifiedOn).toBe(onDisk.verifiedOn);
    expect(Object.keys(loaded.providers)).toStrictEqual(Object.keys(onDisk.providers));
    expect(freeTierLimitsFor('groq', 'llama-3.1-8b-instant').requestsPerDay).toBe(
      onDisk.providers.groq.models['llama-3.1-8b-instant'].requestsPerDay,
    );
  });

  it('carries the Groq numbers measured for the workhorse model', () => {
    // The Provider strategy table in docs/ARCHITECTURE.md. When these move the
    // config file moves and this test follows it -- which is the whole point of
    // the numbers living in a file rather than in code.
    expect(freeTierLimitsFor('groq', 'llama-3.1-8b-instant')).toStrictEqual({
      requestsPerMinute: 30,
      requestsPerDay: 14_400,
      tokensPerMinute: 6000,
    });
  });

  it('falls back to the provider defaults for a model with no entry of its own', () => {
    const limits = freeTierLimitsFor('groq', 'some-model-nobody-configured');
    expect(limits).toStrictEqual(freeTierProvider('groq').defaults);
    // The defaults are the tighter published numbers, never the workhorse's:
    // pacing an unknown model against 14,400 RPD burns a day's quota in an hour.
    expect(limits.requestsPerDay).toBeLessThan(
      freeTierLimitsFor('groq', 'llama-3.1-8b-instant').requestsPerDay,
    );
  });

  it('throws for a provider that has no free-tier entry at all', () => {
    expect(() => freeTierLimitsFor('not-a-provider', 'anything')).toThrow(
      /No free-tier configuration for provider "not-a-provider"/,
    );
    expect(() => freeTierProvider('not-a-provider')).toThrow(/No free-tier configuration/);
  });

  it('returns a frozen structure, so a caller cannot edit a quota at runtime', () => {
    const config = loadFreeTierConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.providers)).toBe(true);
    expect(Object.isFrozen(config.providers.groq)).toBe(true);
    expect(Object.isFrozen(config.providers.groq.defaults)).toBe(true);
    expect(Object.isFrozen(config.providers.groq.endpoints)).toBe(true);
  });

  it('does not memoise, so no cross-call state hides in this module (AC3)', () => {
    expect(loadFreeTierConfig()).not.toBe(loadFreeTierConfig());
    expect(loadFreeTierConfig()).toStrictEqual(loadFreeTierConfig());
  });
});

describe('the free-tier allowlist (INV-8)', () => {
  it('accepts the allowlisted Groq endpoint', () => {
    expect(() => {
      assertFreeTierEndpoint('groq', GROQ_ENDPOINT);
    }).not.toThrow();
  });

  it('rejects a paid endpoint', () => {
    expect(() => {
      assertFreeTierEndpoint('groq', 'https://api.openai.com/v1/chat/completions');
    }).toThrow(/is not on the free-tier allowlist/);
  });

  it('rejects a near-miss rather than prefix-matching it', () => {
    // A `startsWith` allowlist would wave through a paid path hanging off the
    // same host, and a query string is how a tier is usually selected.
    // Membership is exact.
    for (const endpoint of [
      `${GROQ_ENDPOINT}/dedicated`,
      `${GROQ_ENDPOINT}?tier=paid`,
      GROQ_ENDPOINT.replace('https', 'http'),
      ` ${GROQ_ENDPOINT}`,
    ]) {
      expect(() => {
        assertFreeTierEndpoint('groq', endpoint);
      }).toThrow(/is not on the free-tier allowlist/);
    }
  });

  it('names the allowed endpoints in the failure, so the fix is obvious', () => {
    expect(() => {
      assertFreeTierEndpoint('groq', 'https://example.invalid/v1');
    }).toThrow(/api\.groq\.com/);
  });
});

describe('free-tier config validation', () => {
  it('accepts the well-formed document these cases are built from', () => {
    expect(() => loadFreeTierConfig(document())).not.toThrow();
  });

  it('rejects every malformed shape, naming the offending field', () => {
    const cases: readonly (readonly [unknown, RegExp])[] = [
      [null, /root must be an object/],
      [[], /root must be an object/],
      [{ verifiedOn: '   ', providers: { groq: {} } }, /verifiedOn must be a non-empty string/],
      [{ verifiedOn: '2026-08-01', providers: {} }, /providers must not be empty/],
      [{ verifiedOn: '2026-08-01', providers: null }, /providers must be an object/],
      [document({ endpoints: [] }), /endpoints must be a non-empty array/],
      [document({ endpoints: GROQ_ENDPOINT }), /endpoints must be a non-empty array/],
      [document({ endpoints: ['http://api.groq.com/v1'] }), /must be https:\/\/ URLs/],
      [document({ endpoints: [42] }), /must be https:\/\/ URLs/],
      [document({ fallbackBackoffMs: 0 }), /fallbackBackoffMs must be a positive safe integer/],
      [document({ fallbackBackoffMs: -1 }), /fallbackBackoffMs must be a positive safe integer/],
      [document({ fallbackBackoffMs: '60000' }), /fallbackBackoffMs must be a positive safe integer/],
      [document({ maxBackoffMs: 0 }), /maxBackoffMs must be a positive safe integer/],
      // A ceiling below the fallback would make the configured fallback
      // unreachable -- the two numbers must be consistent, not merely valid.
      [document({ maxBackoffMs: 30_000 }), /must not be below fallbackBackoffMs/],
      [
        document({ defaults: { ...VALID_LIMITS, requestsPerMinute: 0 } }),
        /defaults\.requestsPerMinute must be a positive safe integer/,
      ],
      [
        document({ defaults: { ...VALID_LIMITS, requestsPerDay: 1.5 } }),
        /defaults\.requestsPerDay must be a positive safe integer/,
      ],
      [
        document({ defaults: { ...VALID_LIMITS, tokensPerMinute: Number.NaN } }),
        /defaults\.tokensPerMinute must be a positive safe integer/,
      ],
      [
        document({ defaults: { requestsPerMinute: 30, requestsPerDay: 1000 } }),
        /defaults\.tokensPerMinute must be a positive safe integer/,
      ],
      [document({ defaults: 'plenty' }), /defaults must be an object/],
      [document({ models: null }), /models must be an object/],
      [
        document({ models: { 'a-model': { ...VALID_LIMITS, requestsPerDay: -3 } } }),
        /models\.a-model\.requestsPerDay must be a positive safe integer/,
      ],
    ];

    for (const [malformed, expected] of cases) {
      expect(() => loadFreeTierConfig(malformed)).toThrow(expected);
    }
  });

  it('validates a config handed in by a caller, not only the committed one', () => {
    // The one path by which an unvalidated endpoint could otherwise reach a
    // request: an injected document that skipped the loader.
    expect(() => loadFreeTierConfig(document({ endpoints: ['https://paid.invalid/v1'] }))).not.toThrow();
    expect(() =>
      assertFreeTierEndpoint(
        'groq',
        GROQ_ENDPOINT,
        loadFreeTierConfig(document({ endpoints: ['https://paid.invalid/v1'] })),
      ),
    ).toThrow(/is not on the free-tier allowlist/);
  });
});
