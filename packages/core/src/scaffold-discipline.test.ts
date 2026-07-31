import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assemblePrompt } from './scaffold';
import { createDeployment } from './deployment';
import { createMockProviderClient } from './testing/mock-provider';

/**
 * AC2: the grep-level half of INV-7. `scripts/audit-invariants.sh` runs the
 * equivalent sweep in CI; running it from inside the suite means a local
 * `npm test` catches the violation too, and means the *reason* the tokens are
 * banned is stated next to the check rather than only in a shell script.
 *
 * Test files are exempt -- this one has to write the banned tokens out in order
 * to search for them, and the audit script exempts `*.test.ts` for exactly the
 * same reason.
 */

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every mechanism by which a prompt could be varied per Deployment. Naming a
 * thing is how it gets built, so the names are refused outright: a Deployment
 * that would do better with different phrasing is a published caveat (INV-7),
 * and there is no code shape that expresses "just for this one model".
 */
const BANNED_OVERRIDE_TOKENS: readonly string[] = [
  'promptOverride',
  'systemPromptFor',
  'scaffoldFor',
  'perModelPrompt',
  'modelSpecificPrompt',
];

interface ShippedFile {
  readonly path: string;
  readonly source: string;
}

/** Every shipped (non-test) TypeScript file under `packages/*​/src`, recursively. */
function shippedFiles(directory: string, collected: ShippedFile[] = []): ShippedFile[] {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') {
      continue;
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      shippedFiles(path, collected);
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.spec.ts')) {
      continue;
    }
    collected.push({ path, source: readFileSync(path, 'utf8') });
  }
  return collected;
}

function allShippedFiles(): readonly ShippedFile[] {
  const collected: ShippedFile[] = [];
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    const src = join(PACKAGES_ROOT, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    shippedFiles(src, collected);
  }
  return collected;
}

describe('no per-Deployment prompt override mechanism exists (AC2, INV-7)', () => {
  it('sweeps a non-trivial set of shipped files, so a passing sweep means something', () => {
    const files = allShippedFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files.some(({ path }) => path.endsWith('scaffold.ts'))).toBe(true);
    expect(files.some(({ path }) => path.endsWith('deployment.ts'))).toBe(true);
  });

  it('contains none of the override identifiers, in code or in prose', () => {
    const offences: string[] = [];

    for (const { path, source } of allShippedFiles()) {
      source.split('\n').forEach((text, index) => {
        for (const token of BANNED_OVERRIDE_TOKENS) {
          if (text.includes(token)) {
            offences.push(`${path}:${index + 1}: ${token}`);
          }
        }
      });
    }

    expect(offences).toStrictEqual([]);
  });

  it('holds no model-keyed prompt map: nothing shipped indexes a prompt by model', () => {
    const offences: string[] = [];
    // A prompt held in a keyed collection, or one indexed by something
    // identity-shaped. `Prompt[]` is an array of prompts and deliberately does
    // not match -- the ban is on keying a prompt by *who is being asked*, not
    // on ever putting prompts in a list.
    const keyedCollection = /(prompt|scaffold|system)s?\s*:\s*(Record|Map)\b/i;
    const identityIndexed = /(prompt|scaffold|system)s?\s*\[\s*(['"`]|model|provider|deployment|agent)/i;

    for (const { path, source } of allShippedFiles()) {
      source.split('\n').forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          return;
        }
        if (keyedCollection.test(text) || identityIndexed.test(text)) {
          offences.push(`${path}:${index + 1}: ${trimmed}`);
        }
      });
    }

    expect(offences).toStrictEqual([]);
  });
});

describe('prompt assembly has no Deployment-shaped seam (AC1, AC3)', () => {
  it('assemblePrompt accepts nothing that identifies a Deployment', () => {
    expect(assemblePrompt.length).toBe(3);
    expect(assemblePrompt.name).toBe('assemblePrompt');
  });

  it('a Deployment exposes no way to reach its own prompt assembly', () => {
    const agent = createDeployment({ client: createMockProviderClient({ script: [] }) });

    // `id`, `kind`, `observe`, `decide` and nothing else: no config bag, no
    // prompt hook, no scaffold property a caller could reassign.
    expect(Object.keys(agent).sort()).toStrictEqual(['decide', 'id', 'kind', 'observe']);
  });
});
