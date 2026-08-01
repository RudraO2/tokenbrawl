import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/assert-no-secret-leak.sh` is the fourth and last of Story 5.3's AC5
 * mechanisms, and the only one that does not trust the other three. It is also
 * the one whose failure is completely invisible: a leak detector that silently
 * matches nothing reports the same "ok" as a clean tree, and the first
 * evidence of the difference is a key on a public repository.
 *
 * So it gets exercised against a tree with a planted secret in it, which is
 * the only way to tell "found nothing" apart from "looked for nothing".
 *
 * The script is spawned rather than reimplemented: the thing under test is the
 * shell, including its `grep` flags. A TypeScript reimplementation would pass
 * while the real script was broken, which is the failure mode this file exists
 * to close.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'assert-no-secret-leak.sh');

/** Not a real key, and long enough to clear the script's MIN_SECRET_LENGTH. */
const PLANTED = 'gsk_live_0123456789abcdefplanted';

interface RunResult {
  readonly status: number;
  readonly output: string;
}

function runScript(cwd: string, env: Record<string, string>, args: readonly string[]): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    // A clean environment plus exactly what the case supplies: inheriting the
    // developer's own shell could hand the script a real key from a `.env`
    // they happen to have exported, and the case would then pass or fail for
    // a reason that has nothing to do with the code.
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

describe('scripts/assert-no-secret-leak.sh', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tokenbrawl-leak-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('passes on a tree that does not contain the key', () => {
    writeFileSync(join(workspace, 'log.json'), '{"matchId":"abc","outcome":"win"}\n');

    const { status, output } = runScript(workspace, { GROQ_API_KEY: PLANTED }, ['GROQ_API_KEY']);

    expect(status).toBe(0);
    expect(output).toContain('secret leak check passed');
  });

  it('fails on a tree that does contain it, and names the file', () => {
    writeFileSync(join(workspace, 'leaked.json'), `{"endpoint":"https://x/?key=${PLANTED}"}\n`);

    const { status, output } = runScript(workspace, { GROQ_API_KEY: PLANTED }, ['GROQ_API_KEY']);

    expect(status).toBe(1);
    expect(output).toContain('leaked.json');
    expect(output).toContain('SECRET LEAK CHECK FAILED');
  });

  it('never prints the value it is looking for', () => {
    // A leak detector that echoes its evidence into a public CI log is itself
    // the leak. This is the assertion that keeps the diagnostics honest.
    writeFileSync(join(workspace, 'leaked.json'), `${PLANTED}\n`);

    const { output } = runScript(workspace, { GROQ_API_KEY: PLANTED }, ['GROQ_API_KEY']);

    expect(output).not.toContain(PLANTED);
    expect(output).toContain('GROQ_API_KEY');
  });

  it('finds a key buried in a subdirectory', () => {
    mkdirSync(join(workspace, 'apps', 'web', 'public', 'replays'), { recursive: true });
    writeFileSync(join(workspace, 'apps', 'web', 'public', 'replays', 'a.command-log.json'), `${PLANTED}\n`);

    expect(runScript(workspace, { GROQ_API_KEY: PLANTED }, ['GROQ_API_KEY']).status).toBe(1);
  });

  it('scans every variable it is given, not just the first', () => {
    writeFileSync(join(workspace, 'leaked.json'), `${PLANTED}\n`);

    const { status } = runScript(
      workspace,
      { GROQ_API_KEY: 'not-in-the-tree-at-all', CEREBRAS_API_KEY: PLANTED },
      ['GROQ_API_KEY', 'CEREBRAS_API_KEY'],
    );

    expect(status).toBe(1);
  });

  it('treats a key containing regex metacharacters as a literal', () => {
    // `-F` is why. A pattern built from a key that contains `+` or `.` quietly
    // stops matching the very string it exists to find, and the script would
    // then pass on a tree that is leaking.
    const awkward = 'csk-a+b.c*d[e]f-0123456789';
    writeFileSync(join(workspace, 'leaked.json'), `${awkward}\n`);

    expect(runScript(workspace, { CEREBRAS_API_KEY: awkward }, ['CEREBRAS_API_KEY']).status).toBe(1);
  });

  it('refuses to report a pass when it was given no variables', () => {
    // "Nothing was checked" and "nothing was found" must never produce the
    // same exit code: a workflow that dropped the arguments would otherwise
    // commit with the gate silently disabled.
    expect(runScript(workspace, {}, []).status).toBe(2);
  });

  it('refuses to report a pass when every named variable is empty', () => {
    writeFileSync(join(workspace, 'log.json'), 'nothing secret here\n');

    const { status, output } = runScript(workspace, { GROQ_API_KEY: '' }, ['GROQ_API_KEY']);

    expect(status).toBe(2);
    expect(output).toContain('nothing');
  });

  it('rejects a secret too short to scan for rather than matching everything', () => {
    // A one-character "key" would match almost every file in the repository.
    // Mirrors MIN_API_KEY_LENGTH in secrets.ts, and fails loudly rather than
    // turning the gate into an unconditional failure nobody can interpret.
    writeFileSync(join(workspace, 'log.json'), 'aaaa\n');

    const { status, output } = runScript(workspace, { GROQ_API_KEY: 'aaaa' }, ['GROQ_API_KEY']);

    expect(status).toBe(1);
    expect(output).toContain('shorter than');
  });

  it('ignores the .git directory', () => {
    // Otherwise a key committed and then removed would keep failing every
    // future run from the object store, with no way to make it pass.
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'COMMIT_EDITMSG'), `${PLANTED}\n`);

    expect(runScript(workspace, { GROQ_API_KEY: PLANTED }, ['GROQ_API_KEY']).status).toBe(0);
  });
});
