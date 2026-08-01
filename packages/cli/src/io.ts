/**
 * The CLI's whole relationship with the outside world, as one interface.
 *
 * Every module in this package takes a `CliIo` rather than importing
 * `node:fs`, and the Node implementation lives in `node-io.ts`, which nothing
 * but `cli.ts` imports. That buys two things:
 *
 * 1. A whole tournament -- plan, resume, run, write -- executes in a test
 *    against an in-memory map, in milliseconds, with no temp directory and
 *    nothing to clean up afterwards.
 * 2. `env` is *part of the port*. That turns "a provider key is read from the
 *    environment only" (AC3) from a convention into a typed statement: there
 *    is exactly one place a key can come from, `config.ts` has no field for a
 *    second one, and a module that wanted one would have to invent it in the
 *    open.
 *
 * AD-4's "no Node built-in" rule scopes `packages/env-*` and does not bind
 * here -- a CLI that cannot touch a filesystem is not a CLI. What binds here
 * is that the built-ins stay at the edge.
 */

export interface CliIo {
  /**
   * The process environment. Read-only by construction: nothing in this
   * package writes to it, and a key is never copied out of it into a config
   * object, a log, or a file name.
   */
  readonly env: Readonly<Record<string, string | undefined>>;

  /** Rejects if the file does not exist. Callers that tolerate absence catch. */
  readFile(path: string): Promise<string>;

  /**
   * Writes `contents` to `path`.
   *
   * **Atomic**: a reader must never observe a partially written file. A
   * tournament killed mid-write is the ordinary case this package is built
   * for (AC4), and a truncated Command Log that a later resume mistook for a
   * completed Match would leave a permanent hole in a tournament nobody
   * re-runs.
   */
  writeFile(path: string, contents: string): Promise<void>;

  /**
   * Base names of the files directly in `dir`, non-recursive. A directory
   * that does not exist yet is an empty list, not an error: the first run of
   * a tournament has no output directory, and that is not a failure state.
   */
  listFiles(dir: string): Promise<readonly string[]>;

  ensureDir(dir: string): Promise<void>;

  /** One line of ordinary output. The newline is the implementation's business. */
  out(line: string): void;

  /** One line of diagnostic output. Warnings and failures, never results. */
  err(line: string): void;
}
