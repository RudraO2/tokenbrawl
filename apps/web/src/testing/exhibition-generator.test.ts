import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Story 12.12, AC1: the generator's no-key path, asserted by running it.
 *
 * This is the one acceptance criterion that can be verified without a provider
 * key, and it is verified the only way that means anything -- by spawning the
 * script with the key removed from the child's environment and reading its exit
 * code, its stderr and the filesystem afterwards. A unit test on
 * `resolveApiKey` would pass on a generator that resolved the key and then wrote
 * a file before checking it, which is exactly the ordering bug that matters here:
 * `secretsFor` must run before anything is planned or played, so a missing key is
 * a message at second zero rather than after a Match has burned free-tier quota.
 *
 * The environment is scrubbed rather than trusted. A developer running the suite
 * on the machine that generated the committed replay has `GROQ_API_KEY` exported,
 * and a test that only passed on a machine without one is a test that passes
 * where it is not needed.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = 'apps/web/scripts/build-exhibition-replay.mts';
const LOG_PATH = join(REPO_ROOT, 'apps', 'web', 'public', 'replays', 'exhibition.command-log.json');
const SIDECAR_PATH = join(REPO_ROOT, 'apps', 'web', 'public', 'replays', 'exhibition.reasoning.json');

/** Every provider key name the exhibition config or its adapters could reach. */
const PROVIDER_KEY_VARS: readonly string[] = [
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
];

function runWithoutKeys(): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of PROVIDER_KEY_VARS) {
    delete env[name];
  }

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      './packages/cli/bin/register.mjs',
      SCRIPT,
    ],
    { cwd: REPO_ROOT, env, encoding: 'utf8' },
  );

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('the exhibition generator with no provider key (AC1)', () => {
  it('exits non-zero, names GROQ_API_KEY exactly, and writes nothing', () => {
    // Snapshotted first, so "writes no file" is assertable even once the real
    // replay is committed: the question is whether this run touched them, not
    // whether they exist.
    const before = [LOG_PATH, SIDECAR_PATH].map((path) =>
      existsSync(path) ? statSync(path).mtimeMs : null,
    );

    const run = runWithoutKeys();

    expect(run.status).not.toBe(0);
    expect(run.status).not.toBeNull();
    // The variable's exact name. A message saying "a provider key is missing"
    // leaves an operator guessing which of three to export.
    expect(run.stderr).toContain('GROQ_API_KEY');
    // And it says where a key may come from, because the next thing a reader
    // reaches for is the config file, which is the one place it must never go.
    expect(run.stderr).toMatch(/environment only/);

    const after = [LOG_PATH, SIDECAR_PATH].map((path) =>
      existsSync(path) ? statSync(path).mtimeMs : null,
    );
    expect(after).toStrictEqual(before);
  });

  it('leaks nothing that looks like a provider key on either stream', () => {
    const run = runWithoutKeys();

    // Groq keys are `gsk_...`, Cerebras `csk-...`, Google `AIzaSy...`. The
    // generator has no key to leak on this path, and that is the point: the check
    // is that its diagnostics quote the variable NAME and never a value shape.
    const keyish = /\b(gsk_[A-Za-z0-9]{8,}|csk-[A-Za-z0-9]{8,}|AIzaSy[A-Za-z0-9_-]{8,})/;
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(keyish);
  });

  it('does not reach the network before it has resolved the key', () => {
    // The ordering claim, read off what the run printed. Both per-Deployment
    // pacing lines and the "playing <matchId>" line are emitted *after*
    // `secretsFor`, so their absence is evidence the key check came first --
    // there is no run in which a call was issued and this message was not
    // printed.
    const run = runWithoutKeys();

    expect(run.stdout).not.toMatch(/playing /);
    expect(run.stdout).not.toMatch(/paced at one call/);
  });
});
