import type { CliIo } from '../io';

/**
 * An in-memory `CliIo`, for tests.
 *
 * Lives under `src/testing/` for the same reason every other package's does:
 * it is not shipped, and keeping it out of the shipped graph is what lets
 * `source-discipline.test.ts` assert that no shipped file reaches into here.
 *
 * Paths are used verbatim as map keys and joined with `/`. That is not a
 * general-purpose path implementation and does not try to be -- the real one
 * is `node:path`, in `node-io.ts`, where it belongs. What this needs to model
 * faithfully is only the two behaviours the runner actually depends on: a
 * directory listing that returns base names, and a write that is atomic.
 */
export interface MemoryIo extends CliIo {
  /** Full path to contents. Inspect it directly in assertions. */
  readonly files: Map<string, string>;
  readonly stdout: string[];
  readonly stderr: string[];
}

export interface MemoryIoInit {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly files?: Readonly<Record<string, string>>;
}

/** Normalises away `./` prefixes and duplicate separators so two spellings of one path are one key. */
export function normalisePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export function createMemoryIo(init: MemoryIoInit = {}): MemoryIo {
  const files = new Map<string, string>();
  for (const [path, contents] of Object.entries(init.files ?? {})) {
    files.set(normalisePath(path), contents);
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const env = Object.freeze({ ...(init.env ?? {}) });

  return {
    env,
    files,
    stdout,
    stderr,

    readFile(path: string): Promise<string> {
      const contents = files.get(normalisePath(path));
      if (contents === undefined) {
        return Promise.reject(new Error(`ENOENT: no such file "${path}"`));
      }
      return Promise.resolve(contents);
    },

    writeFile(path: string, contents: string): Promise<void> {
      files.set(normalisePath(path), contents);
      return Promise.resolve();
    },

    listFiles(dir: string): Promise<readonly string[]> {
      const prefix = normalisePath(dir);
      const names: string[] = [];
      for (const path of files.keys()) {
        const base = prefix === '' ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
        if (base === null || base.includes('/')) {
          continue;
        }
        names.push(base);
      }
      return Promise.resolve(names);
    },

    ensureDir(): Promise<void> {
      // A directory is implied by the paths of the files in it. Nothing to do.
      return Promise.resolve();
    },

    out(line: string): void {
      stdout.push(line);
    },

    err(line: string): void {
      stderr.push(line);
    },
  };
}
