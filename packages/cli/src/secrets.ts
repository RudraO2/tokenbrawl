import type { CliIo } from './io';

/**
 * AC3, as a mechanism rather than as a promise.
 *
 * "The key is read from the environment only and never written to disk or into
 * a log" is easy to believe and hard to keep. The frozen Command Log schema's
 * `additionalProperties: false` already makes it hard for a key to reach a log
 * -- but `endpoint`, `rawResponse` and `reasoning` are free-form strings, and a
 * provider that echoes a request back in an error body, or a future adapter
 * that builds a query-string-authenticated URL, would put one there without
 * anybody editing this package.
 *
 * So two different treatments for two different failure modes:
 *
 * - **What is printed is redacted.** An error message that happens to
 *   interpolate a key must still reach the operator; throwing *during error
 *   reporting* would swap a diagnosable failure for a baffling one.
 * - **What is written is refused.** A Command Log containing an API key is a
 *   corrupt artifact that would then be committed, published and cached. There
 *   is no version of that worth having on disk, so the write throws.
 */

/**
 * Below this length a string is not a provider key, and treating it as one is
 * actively harmful: a one-character "key" would make `redact` replace every
 * occurrence of that character in every line of output, and would make every
 * file write fail because almost any document contains it.
 *
 * So this is not a key-format policy -- providers disagree about those and this
 * package should not have an opinion. It closes a degenerate configuration by
 * rejecting it out loud at resolution time, which is the only moment at which
 * the operator can still do something about it.
 */
export const MIN_API_KEY_LENGTH = 8;

export const REDACTED = '[redacted]';

/**
 * Reads one API key from the environment, and from nowhere else.
 *
 * `env` is the `CliIo` port's, so there is exactly one source in the whole
 * package. `agentId` is only ever used to make the error say which Deployment
 * is unconfigured -- a run that mentions "GROQ_API_KEY is not set" without
 * naming the agent is a worse message for no gain.
 */
export function resolveApiKey(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  agentId: string,
): string {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `Deployment "${agentId}" needs ${variable} in the environment; it is unset or blank. ` +
        `Export it in this shell -- the CLI reads provider keys from the environment only, ` +
        `never from the config file.`,
    );
  }

  const key = raw.trim();
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `Deployment "${agentId}": ${variable} is ${String(key.length)} characters, ` +
        `which is shorter than any provider key (${String(MIN_API_KEY_LENGTH)} minimum). ` +
        `Refusing to run rather than redact half the output with it.`,
    );
  }

  return key;
}

/**
 * Every occurrence of every secret replaced by `[redacted]`.
 *
 * A plain `split`/`join` rather than a `RegExp`: a key can legitimately contain
 * regex metacharacters, and building a pattern from one is how a redactor
 * quietly stops matching the very string it exists to hide.
 *
 * Secrets shorter than `MIN_API_KEY_LENGTH` are ignored. Nothing can produce
 * one -- `resolveApiKey` refuses them -- so this is a second closure of the
 * same degenerate case, against a caller that assembled the list by hand.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < MIN_API_KEY_LENGTH) {
      continue;
    }
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

/** Throws if any secret appears in `text`. `where` names the artifact, never its contents. */
export function assertNoSecrets(text: string, secrets: readonly string[], where: string): void {
  for (const secret of secrets) {
    if (secret.length < MIN_API_KEY_LENGTH) {
      continue;
    }
    if (text.includes(secret)) {
      throw new Error(
        `Refusing to write ${where}: it contains a provider API key. ` +
          `A key must never leave the environment (AC3). Nothing was written.`,
      );
    }
  }
}

/**
 * Wraps an io so the two rules above apply to everything that leaves the
 * process.
 *
 * Deliberately a wrapper rather than a rule each call site remembers: the
 * point of AC3 is that a *future* call site cannot forget. `run.ts` never sees
 * an unguarded io, because `main.ts` guards it once, before any Match exists.
 *
 * `readFile`, `listFiles` and `ensureDir` pass straight through -- they move
 * nothing outward.
 */
export function guardSecrets(io: CliIo, secrets: readonly string[]): CliIo {
  return {
    env: io.env,
    readFile: (path: string) => io.readFile(path),
    listFiles: (dir: string) => io.listFiles(dir),
    ensureDir: (dir: string) => io.ensureDir(dir),

    async writeFile(path: string, contents: string): Promise<void> {
      // The path is checked as well as the contents: a key interpolated into
      // an output file name would be just as leaked, and rather harder to
      // notice than one buried in a document.
      assertNoSecrets(path, secrets, 'a file whose name');
      assertNoSecrets(contents, secrets, path);
      await io.writeFile(path, contents);
    },

    out(line: string): void {
      io.out(redact(line, secrets));
    },

    err(line: string): void {
      io.err(redact(line, secrets));
    },
  };
}
