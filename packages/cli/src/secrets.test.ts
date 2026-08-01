import { describe, expect, it } from 'vitest';
import {
  MIN_API_KEY_LENGTH,
  REDACTED,
  assertNoSecrets,
  guardSecrets,
  redact,
  resolveApiKey,
} from './secrets';
import { createMemoryIo } from './testing/memory-io';

/** A plausible-shaped key that is not one. */
const KEY = 'gsk_live_0123456789abcdef';

describe('resolveApiKey (AC3: from the environment, and nowhere else)', () => {
  it('returns the key from the named environment variable', () => {
    expect(resolveApiKey({ GROQ_API_KEY: KEY }, 'GROQ_API_KEY', 'a')).toBe(KEY);
  });

  it('trims surrounding whitespace, which a shell export routinely adds', () => {
    expect(resolveApiKey({ GROQ_API_KEY: `  ${KEY}\n` }, 'GROQ_API_KEY', 'a')).toBe(KEY);
  });

  it('names the agent and the variable when the key is unset', () => {
    expect(() => resolveApiKey({}, 'GROQ_API_KEY', 'groq:one')).toThrow(/groq:one.*GROQ_API_KEY/s);
  });

  it('treats a blank value as unset', () => {
    expect(() => resolveApiKey({ GROQ_API_KEY: '   ' }, 'GROQ_API_KEY', 'a')).toThrow(/unset or blank/);
  });

  it('never puts the key itself into the error message', () => {
    // A value distinctive enough that its absence from the message is a real
    // assertion -- "short" would have matched the word "shorter" in the copy.
    let message = '';
    try {
      resolveApiKey({ GROQ_API_KEY: 'zqx7' }, 'GROQ_API_KEY', 'a');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('zqx7');
    expect(message).toContain('GROQ_API_KEY');
  });

  it('refuses a key shorter than MIN_API_KEY_LENGTH rather than redacting half the output with it', () => {
    const almost = 'a'.repeat(MIN_API_KEY_LENGTH - 1);
    expect(() => resolveApiKey({ K: almost }, 'K', 'a')).toThrow(/shorter than any provider key/);
    expect(resolveApiKey({ K: 'a'.repeat(MIN_API_KEY_LENGTH) }, 'K', 'a')).toHaveLength(MIN_API_KEY_LENGTH);
  });
});

describe('redact', () => {
  it('replaces every occurrence, not just the first', () => {
    expect(redact(`${KEY} and again ${KEY}`, [KEY])).toBe(`${REDACTED} and again ${REDACTED}`);
  });

  it('handles a key containing regex metacharacters', () => {
    // A RegExp built from the key would stop matching it -- the exact way a
    // redactor quietly fails at the one job it has.
    const awkward = 'sk-a.b*c+d(e)[f]|g';
    expect(redact(`before ${awkward} after`, [awkward])).toBe(`before ${REDACTED} after`);
  });

  it('leaves text alone when no secret is present', () => {
    expect(redact('nothing to see', [KEY])).toBe('nothing to see');
  });

  it('ignores a too-short secret rather than shredding the output', () => {
    expect(redact('aaaa bbbb', ['a'])).toBe('aaaa bbbb');
  });
});

describe('assertNoSecrets', () => {
  it('throws when a secret is present, and names the artifact rather than the secret', () => {
    let message = '';
    try {
      assertNoSecrets(`{"endpoint":"https://x/?key=${KEY}"}`, [KEY], 'replays/abc.json');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('replays/abc.json');
    expect(message).not.toContain(KEY);
  });

  it('passes clean text', () => {
    expect(() => assertNoSecrets('{"a":1}', [KEY], 'x')).not.toThrow();
  });
});

describe('guardSecrets (AC3, as a mechanism)', () => {
  it('refuses to write a file whose contents contain a key, and writes nothing', async () => {
    const io = createMemoryIo();
    const guarded = guardSecrets(io, [KEY]);

    await expect(guarded.writeFile('replays/x.json', `{"k":"${KEY}"}`)).rejects.toThrow(
      /contains a provider API key/,
    );
    expect(io.files.size).toBe(0);
  });

  it('refuses a key interpolated into the file NAME', async () => {
    const io = createMemoryIo();
    const guarded = guardSecrets(io, [KEY]);

    await expect(guarded.writeFile(`replays/${KEY}.json`, '{}')).rejects.toThrow(
      /contains a provider API key/,
    );
    expect(io.files.size).toBe(0);
  });

  it('writes a clean document through unchanged', async () => {
    const io = createMemoryIo();
    await guardSecrets(io, [KEY]).writeFile('replays/x.json', '{"a":1}');
    expect(io.files.get('replays/x.json')).toBe('{"a":1}');
  });

  it('redacts stdout and stderr rather than throwing -- an error must still be readable', () => {
    const io = createMemoryIo();
    const guarded = guardSecrets(io, [KEY]);

    guarded.out(`used ${KEY}`);
    guarded.err(`failed with ${KEY}`);

    expect(io.stdout).toStrictEqual([`used ${REDACTED}`]);
    expect(io.stderr).toStrictEqual([`failed with ${REDACTED}`]);
  });

  it('passes reads straight through', async () => {
    const io = createMemoryIo({ files: { 'a.json': '{"a":1}' } });
    const guarded = guardSecrets(io, [KEY]);

    expect(await guarded.readFile('a.json')).toBe('{"a":1}');
    expect(await guarded.listFiles('.')).toStrictEqual(['a.json']);
  });

  it('exposes the same env object -- there is one source for a key', () => {
    const io = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    expect(guardSecrets(io, [KEY]).env).toBe(io.env);
  });
});
