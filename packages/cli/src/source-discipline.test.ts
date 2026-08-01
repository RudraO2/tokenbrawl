import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AC1 as a grep, and it is the only form of that criterion that stays true.
 *
 * "It uses the same Harness and the same Command Log schema as CI -- no forked
 * logic anywhere" is a statement nobody can keep by being careful. What keeps
 * it is that a second serialiser, a second hasher, a second schema literal or
 * a second decision-entry mapping *fails a test the moment it is written* --
 * because each of those is how the CLI and CI quietly start producing
 * different documents for the same Match, and the divergence is invisible
 * until two datasets are joined.
 *
 * The same file also pins the io boundary: Node built-ins are legal in this
 * package (AD-4 scopes `packages/env-*`), but only in `node-io.ts` and
 * `cli.ts`. A `node:fs` import creeping into `run.ts` would not break
 * anything visibly -- it would just make the runner untestable without a disk,
 * one call site at a time.
 *
 * Test files are exempt: this one imports `node:fs` to do its own job.
 */

const SHIPPED_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** The two files that are allowed to touch Node, and why, are documented in `io.ts`. */
const NODE_EDGE_FILES: readonly string[] = ['node-io.ts', 'cli.ts'];

interface ShippedFile {
  readonly name: string;
  readonly source: string;
}

function shippedFiles(): readonly ShippedFile[] {
  return readdirSync(SHIPPED_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(join(SHIPPED_DIRECTORY, name), 'utf8') }));
}

/** Lines that are wholly a comment: prose may legitimately mention a banned token. */
function codeLines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*')
      );
    });
}

function offendingLines(pattern: RegExp, exempt: readonly string[] = []): readonly string[] {
  const offences: string[] = [];
  for (const { name, source } of shippedFiles()) {
    if (exempt.includes(name)) {
      continue;
    }
    for (const { line, text } of codeLines(source)) {
      if (pattern.test(text)) {
        offences.push(`${name}:${line}: ${text.trim()}`);
      }
    }
  }
  return offences;
}

function sourceOf(name: string): string {
  return readFileSync(join(SHIPPED_DIRECTORY, name), 'utf8');
}

describe('the shipped file set is what this file thinks it is', () => {
  it('finds every module the package ships', () => {
    expect(shippedFiles().map((file) => file.name).sort()).toStrictEqual([
      'agents.ts',
      'cli.ts',
      'config.ts',
      'index.ts',
      'io.ts',
      'main.ts',
      'node-io.ts',
      'plan.ts',
      'quota.ts',
      'run.ts',
      'secrets.ts',
    ]);
  });
});

describe('AC1: no forked logic -- the Command Log comes from packages/core', () => {
  it('builds every log through core’s buildCommandLog', () => {
    expect(sourceOf('run.ts')).toMatch(/import \{ buildCommandLog \} from '\.\.\/\.\.\/core\/src\/command-log'/);
  });

  it('plays every Match through core’s runMatch', () => {
    expect(sourceOf('run.ts')).toMatch(/import \{ runMatch \} from '\.\.\/\.\.\/core\/src\/match-runner'/);
  });

  it('derives matchId and configHash through core, never locally', () => {
    expect(sourceOf('plan.ts')).toMatch(/computeConfigHash, computeMatchId, validateCommandLog/);
  });

  it('never writes a schemaVersion of its own', () => {
    // A hand-assembled log is the fork: it would validate today and drift the
    // first time the builder gains a field.
    expect(offendingLines(/schemaVersion\s*:/)).toStrictEqual([]);
    expect(offendingLines(/SCHEMA_VERSION/)).toStrictEqual([]);
  });

  it('never maps a decision entry itself', () => {
    // `agentIndex` is deliberately absent from this list: it is the frozen
    // `0 | 1` side index and appears as an honest *parameter* type all over
    // this package. The five below are fields only a Command Log carries, so
    // any of them on the left of a colon here means a document was assembled
    // by hand rather than by `buildCommandLog`.
    expect(
      offendingLines(/\b(bankRemaining|tokensSpent|reasoningTokens|parseFailure|finalStateHash)\s*:/),
    ).toStrictEqual([]);
  });

  it('never computes a hash itself', () => {
    expect(offendingLines(/\b(createHash|sha256|canonicalStringify|canonicalSha256)\b/)).toStrictEqual([]);
  });

  it('never validates a Command Log against a schema of its own', () => {
    expect(offendingLines(/\b(Ajv|ajv|command-log\.schema)\b/)).toStrictEqual([]);
  });
});

describe('the io boundary', () => {
  it('confines Node built-ins to the two edge files', () => {
    expect(offendingLines(/from '(node:[a-z/]+|fs|path|process)'/, NODE_EDGE_FILES)).toStrictEqual([]);
  });

  it('confines the Node process global to the two edge files', () => {
    expect(offendingLines(/(^|[^A-Za-z0-9_$.])(process|Buffer|__dirname|__filename)\s*[.(]/, NODE_EDGE_FILES))
      .toStrictEqual([]);
  });

  it('keeps the test-only in-memory io out of the shipped graph', () => {
    expect(offendingLines(/from '\.\/testing\//)).toStrictEqual([]);
  });
});

describe('house rules', () => {
  it('declares no module-level let or var', () => {
    const offences: string[] = [];
    for (const { name, source } of shippedFiles()) {
      for (const { line, text } of codeLines(source)) {
        if (/^(let|var)\s/.test(text)) {
          offences.push(`${name}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('adds no runtime dependency (INV-8)', () => {
    const manifest = JSON.parse(readFileSync(join(SHIPPED_DIRECTORY, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toBeUndefined();
  });

  it('writes no state store beside the logs (AD-9, INV-8)', () => {
    // The resumable state is the set of committed Command Logs. A manifest, a
    // lock file or a queue would each be a small database, and each would then
    // be the thing that has to be kept in sync with the directory.
    expect(offendingLines(/\.(lock|manifest|state|db|sqlite)\b/)).toStrictEqual([]);
  });
});
