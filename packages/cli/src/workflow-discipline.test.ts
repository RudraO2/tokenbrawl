import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRunConfig, type DeploymentAgentConfig } from './config';
import { planTournament } from './plan';

/**
 * Story 5.3's acceptance criteria, as checks rather than as promises.
 *
 * The workflow is the one artifact in this repo that **cannot be covered by
 * running it**: a cron expression's correctness is only observable a week
 * later, and the failure mode of every criterion below is silent. A paid
 * runner still goes green. A secret interpolated into a `run:` body still goes
 * green -- and prints the key. A commit step that runs before the leak check
 * still goes green, having already pushed. So each of those is pinned here,
 * where breaking it fails in seconds instead of in production.
 *
 * Text checks rather than a YAML parse, deliberately: parsing would mean a
 * runtime dependency (INV-8's dependency discipline, and `source-discipline.test.ts`
 * asserts this package declares none), and every property below is a property
 * of the file's *text* anyway -- "the secret never appears in a shell" is a
 * statement about lines, not about a parsed tree.
 *
 * Lives in `packages/cli` because the workflow's entire job is to invoke this
 * package's CLI against this repo's committed config, and the most valuable
 * check here is the one that ties the three together: every `apiKeyEnv` the
 * config names must be bound from an Actions secret by the workflow.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const TOURNAMENT_WORKFLOW = 'tournament.yml';
const TOURNAMENT_CONFIG_PATH = join(REPO_ROOT, 'configs', 'tournament.config.json');

function workflowNames(): readonly string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function workflowSource(name: string): string {
  return readFileSync(join(WORKFLOW_DIR, name), 'utf8');
}

function tournamentSource(): string {
  return workflowSource(TOURNAMENT_WORKFLOW);
}

/** Lines that are wholly a YAML comment: prose legitimately names a banned token. */
function codeLines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.trim().length > 0 && !text.trim().startsWith('#'));
}

describe('INV-8: every workflow runs on free minutes for a public repository', () => {
  it('finds the workflows this file thinks exist', () => {
    expect(workflowNames()).toStrictEqual(['ci.yml', TOURNAMENT_WORKFLOW]);
  });

  it('uses only GitHub-hosted standard runners', () => {
    // `self-hosted` is a machine somebody pays for, and every `-Nx` larger
    // runner (`ubuntu-latest-4-cores`) bills per minute even on a public
    // repository. Both are "zero recurring cost" failures that no test would
    // otherwise notice until an invoice arrived.
    const offences: string[] = [];
    for (const name of workflowNames()) {
      for (const { line, text } of codeLines(workflowSource(name))) {
        const match = /^\s*runs-on:\s*(.+?)\s*$/.exec(text);
        if (match === null) {
          continue;
        }
        if (!/^(ubuntu-latest|ubuntu-\d\d\.\d\d|macos-latest|windows-latest)$/.test(match[1])) {
          offences.push(`${name}:${String(line)}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('adds no paid service call to a workflow', () => {
    const offences: string[] = [];
    for (const name of workflowNames()) {
      for (const { line, text } of codeLines(workflowSource(name))) {
        if (/\b(self-hosted|runs-on:\s*\[)/.test(text)) {
          offences.push(`${name}:${String(line)}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});

describe('AC1: the tournament is cron-scheduled and manually dispatchable', () => {
  it('runs one segment every day, not only on weekdays', () => {
    // Nine segments, because Story 7.1's both-sides plan is ~9,000 calls per
    // Deployment against a 1,000-RPD ceiling. Seven days rather than five
    // because the free-tier allowance resets daily whether or not it is used:
    // a Monday-to-Friday cadence discards two days of it per week.
    //
    // Pinned rather than left to prose for the reason every schedule value in
    // this file is pinned: a cron expression's correctness is only observable
    // a week later, so a quiet edit back to `1-5` would silently stretch every
    // tournament by five days and nothing would go red.
    expect(tournamentSource()).toMatch(/^\s*- cron: '0 3 \* \* \*'$/m);
  });

  it('can also be dispatched by hand, defaulting to the rehearsal', () => {
    expect(tournamentSource()).toMatch(/^\s{2}workflow_dispatch:$/m);
    // The manual button is the one pressed by someone who is unsure, and the
    // safe default for an unsure press spends nothing.
    expect(tournamentSource()).toMatch(/dry_run:[\s\S]{0,200}?default: true/);
  });

  it('never lets two segments run at once', () => {
    // Two concurrent segments would double-spend the daily quota the schedule
    // exists to conserve, and would race each other's push.
    expect(tournamentSource()).toMatch(/^concurrency:$/m);
    expect(tournamentSource()).toMatch(/^\s{2}group: tournament$/m);
    expect(tournamentSource()).toMatch(/^\s{2}cancel-in-progress: false$/m);
  });

  it('bounds a segment inside GitHub’s job cap', () => {
    const match = /timeout-minutes:\s*(\d+)/.exec(tournamentSource());
    expect(match).not.toBeNull();
    expect(Number((match as RegExpExecArray)[1])).toBeLessThan(360);
  });
});

describe('the workflow’s invocation actually reaches the CLI', () => {
  it('does not go through `npm run`, which eats --config and --dry-run', () => {
    // Found by running the documented command on a real machine. npm treats
    // `--config` and `--dry-run` as its OWN flags and consumes them even after
    // `--`, so the CLI received `tournament configs/tournament.config.json`
    // with both options stripped and exited 2 on "Unexpected argument".
    //
    // The second reason is worse and silent: `-w packages/cli` runs with
    // cwd = packages/cli, so the config's relative `outputDir` resolves to
    // packages/cli/apps/web/public/replays -- outside COMMIT_PATHS. Every
    // Match runs, costs real quota, and is staged by nothing.
    // Comment lines dropped: the workflow's own prose explains *why* it does
    // not use npm, and naming the banned form is how that stays legible.
    const offences = codeLines(tournamentSource())
      .filter(({ text }) => /npm run tokenbrawl/.test(text))
      .map(({ line, text }) => `${String(line)}: ${text.trim()}`);
    expect(offences).toStrictEqual([]);
  });

  it('runs the CLI from the repository root, so relative paths resolve there', () => {
    expect(tournamentSource()).toMatch(/--import \.\/packages\/cli\/bin\/register\.mjs packages\/cli\/src\/cli\.ts/);
  });

  it('really does parse both flags when spawned exactly as the workflow spawns it', () => {
    // The only assertion here that could have caught the npm defect: a text
    // check on an invocation nobody runs proves nothing. This spawns it.
    //
    // Dummy keys because a dry run resolves every key (D2) but issues no
    // provider call -- they need only clear MIN_API_KEY_LENGTH.
    const dummy = 'dummy-key-not-real-0123';
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--import',
        './packages/cli/bin/register.mjs',
        'packages/cli/src/cli.ts',
        'tournament',
        '--config',
        'configs/tournament.config.json',
        '--dry-run',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          GROQ_API_KEY: dummy,
          CEREBRAS_API_KEY: dummy,
          GOOGLE_AI_STUDIO_API_KEY: dummy,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('900 planned');
    // The plan was actually enumerated, not just counted.
    expect(result.stdout.split('\n').filter((line) => line.startsWith('would run'))).toHaveLength(900);
  }, 30_000);
});

describe('AC2: results are committed back, and the commit is path-based', () => {
  it('can write to the repository', () => {
    expect(tournamentSource()).toMatch(/^\s{2}contents: write$/m);
  });

  it('stages the replay directory the site serves, and the reports directory', () => {
    // Path-based rather than artifact-based so Story 7.2's leaderboard is
    // committed by this workflow with no edit to it. If this assertion is
    // changed, re-read the spec's "What it deliberately does not build".
    expect(tournamentSource()).toMatch(/COMMIT_PATHS: apps\/web\/public\/replays docs\/reports/);
    expect(tournamentSource()).toMatch(/git add -- \$COMMIT_PATHS/);
  });

  it('commits nothing when the segment produced nothing', () => {
    expect(tournamentSource()).toMatch(/git diff --cached --quiet/);
  });
});

describe('AC3: the commit is the deploy, and there is no deploy hook', () => {
  it('calls no deploy hook from any workflow', () => {
    // AC3 says a separate deploy hook "is not needed" because a commit on the
    // default branch triggers the static redeploy through Vercel's own git
    // integration. That is only true for as long as nobody adds one, and a
    // hook added later would be an outward-facing side effect on a schedule
    // nobody is watching.
    const offences: string[] = [];
    for (const name of workflowNames()) {
      for (const { line, text } of codeLines(workflowSource(name))) {
        if (/(vercel\s+(deploy|--prod)|actions-gh-pages|deploy-hooks?|netlify\s+deploy|deploy_url)/i.test(text)) {
          offences.push(`${name}:${String(line)}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});

describe('AC5: a secret is read from Actions secrets and never reaches a shell', () => {
  it('interpolates a secret only as a bare NAME: ${{ secrets.X }} binding', () => {
    // The failure this prevents is specific and bad: `run: echo "$KEY"` with
    // the value substituted by the expression engine puts the key in the log
    // stream, where `set -x` or a failing command's own error text prints it.
    // A binding line has no shell on it at all.
    const offences: string[] = [];
    for (const name of workflowNames()) {
      for (const { line, text } of codeLines(workflowSource(name))) {
        if (!text.includes('secrets.')) {
          continue;
        }
        if (!/^\s*[A-Z][A-Z0-9_]*:\s*\$\{\{\s*secrets\.[A-Z][A-Z0-9_]*\s*\}\}\s*$/.test(text)) {
          offences.push(`${name}:${String(line)}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('runs the leak check before the commit step, never after', () => {
    // Ordering is the entire value of the check. A key pushed to a public
    // repository has to be rotated; it cannot be un-pushed.
    const source = tournamentSource();
    const leakAt = source.indexOf('assert-no-secret-leak.sh');
    const commitAt = source.indexOf('git add -- $COMMIT_PATHS');
    expect(leakAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(-1);
    expect(leakAt).toBeLessThan(commitAt);
  });

  it('gates the commit step on the leak check having passed', () => {
    // `if: always()` on the commit step would otherwise run it even after the
    // leak check failed, which is the exact opposite of the point.
    expect(tournamentSource()).toMatch(/steps\.leak\.outcome == 'success'/);
  });

  it('never commits during a rehearsal, and never off the default branch', () => {
    expect(tournamentSource()).toMatch(/env\.DRY_RUN != 'true'/);
    expect(tournamentSource()).toMatch(/github\.ref == 'refs\/heads\/main'/);
  });

  it('contains no literal that looks like a provider key', () => {
    const offences: string[] = [];
    for (const name of workflowNames()) {
      for (const { line, text } of codeLines(workflowSource(name))) {
        if (/\b(gsk_[A-Za-z0-9_]{8,}|csk-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{10,})\b/.test(text)) {
          offences.push(`${name}:${String(line)}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});

describe('the committed tournament config is the one FR-20 describes', () => {
  const config = parseRunConfig(readFileSync(TOURNAMENT_CONFIG_PATH, 'utf8'));

  it('parses through the real parser, not a test copy of it', () => {
    // The config is data the workflow depends on at 03:00 with nobody
    // watching. A typo in a provider id or an id that violates the frozen
    // Agent pattern would fail there, five days of quota into a week.
    expect(config.agents).toHaveLength(6);
  });

  it('reproduces FR-20’s arithmetic, doubled by Story 7.1: 900 Matches, 300 per Deployment', () => {
    // Raised from 450 / 150 by Story 7.1, never loosened into a range. The pin
    // is what keeps a quiet edit to `seedCount` from halving a tournament
    // without anyone noticing -- the same class of weakening the
    // skill-separation thresholds are pinned against in `audit-invariants.sh`.
    const planned = planTournament(config);
    expect(planned).toHaveLength(900);

    for (const agent of config.agents.filter((a) => a.kind === 'deployment')) {
      const appearances = planned.filter((match) => match.agentIds.includes(agent.id));
      // 5 opponents x 30 seeds x 2 sides. At ~30 Decision Points each that is
      // ~9,000 calls per Deployment per tournament -- double FR-20's ~4,500,
      // which is the price of removing the side bias 5.1 left in place.
      expect(appearances).toHaveLength(300);
    }
  });

  it('gives every Deployment the same number of Matches on each side (Story 7.1, AC1)', () => {
    const planned = planTournament(config);
    for (const agent of config.agents) {
      const onSide0 = planned.filter((match) => match.agentIds[0] === agent.id).length;
      const onSide1 = planned.filter((match) => match.agentIds[1] === agent.id).length;
      expect(onSide0).toBe(onSide1);
      expect(onSide0).toBeGreaterThan(0);
    }
  });

  it('runs one ranked Deployment per provider', () => {
    // Two ranked Deployments on one provider would contend for a single daily
    // quota, which is what `validateTournamentConfig` warns about.
    const providers = config.agents
      .filter((agent): agent is DeploymentAgentConfig => agent.kind === 'deployment' && agent.ranked)
      .map((agent) => agent.provider);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it('carries all three Baseline Bots, so every results table can show them', () => {
    const bots = config.agents.filter((agent) => agent.kind === 'bot').map((agent) => agent.id);
    expect(bots).toHaveLength(3);
  });

  it('writes into the directory the static site serves', () => {
    // AC3's mechanism: the commit is the redeploy, so the logs have to land
    // where the built site reads them or the redeploy publishes nothing new.
    expect(config.outputDir).toBe('apps/web/public/replays');
  });

  it('writes into a directory the commit step actually stages', () => {
    // The degenerate configuration this closes is silent and total: an
    // `outputDir` outside COMMIT_PATHS runs a full segment, spends a real
    // day of provider quota, writes every log -- and then stages none of
    // them. The next segment finds nothing committed, plans the identical
    // set, and does it again. Forever, green every time.
    //
    // Asserted as a relationship rather than as two matching literals,
    // because the literal version passes the moment someone edits one side.
    const match = /COMMIT_PATHS:\s*(.+)/.exec(tournamentSource());
    expect(match).not.toBeNull();
    const staged = (match as RegExpExecArray)[1].trim().split(/\s+/);
    expect(staged.some((path) => config.outputDir === path || config.outputDir.startsWith(`${path}/`))).toBe(true);
  });

  it('is the config the workflow actually defaults to running', () => {
    // Every assertion in this block validates the file at TOURNAMENT_CONFIG_PATH.
    // If the workflow's default input pointed somewhere else, all of them
    // would be checking a document nothing runs.
    expect(tournamentSource()).toMatch(/default: configs\/tournament\.config\.json$/m);
    expect(tournamentSource()).toMatch(/CONFIG_PATH:.*'configs\/tournament\.config\.json'/);
  });

  it('has every apiKeyEnv it names bound from an Actions secret by the workflow', () => {
    // The check that ties config, workflow and secrets together. Adding a
    // fourth Deployment without adding its secret binding is otherwise a
    // silent failure five days into a tournament.
    const source = tournamentSource();
    for (const agent of config.agents.filter(
      (a): a is DeploymentAgentConfig => a.kind === 'deployment',
    )) {
      expect(source).toContain(`${agent.apiKeyEnv}: \${{ secrets.${agent.apiKeyEnv} }}`);
    }
  });

  it('names no key, only variable names', () => {
    const raw = readFileSync(TOURNAMENT_CONFIG_PATH, 'utf8');
    expect(raw).not.toMatch(/\b(gsk_[A-Za-z0-9_]{8,}|csk-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{10,})\b/);
  });
});
