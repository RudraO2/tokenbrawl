import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Story 9.1 / AD-16.
 *
 * The professor's reference project (Extraction, also called NextGen) lives
 * outside this repository, and has to be available to render against before
 * the four final AI-generated characters exist. Nothing about that reference
 * may ever land in a tracked file or under `apps/web/public` --
 * `extraction-exclusion.test.ts` in `packages/cli` is the mechanical half of
 * that rule, and this plugin is the other half: the one place an out-of-root
 * path is allowed to be typed in, and it is a gitignored, personal, dev-only
 * file.
 *
 * The name is spelled out deliberately with a parenthetical, never as
 * "Extraction" immediately followed by a slash -- that shape is exactly the
 * pattern `extraction-exclusion.test.ts`'s sweep looks for, and this file is
 * a tracked, non-`.md` source file the sweep does not otherwise exempt.
 *
 * `apply: 'serve'` is the load-bearing guarantee. Vite only includes
 * `serve`-scoped plugins in the dev server's plugin list, never in
 * `vite build`'s -- so this plugin is structurally absent from a production
 * build, not just conventionally unused. A missing or malformed config file
 * must never throw: CI, a reviewer, and every machine other than the
 * developer's own will never have `sprites.local.json`, and both the dev
 * server and `vite build` must succeed exactly as if this plugin were absent.
 */

// Resolved relative to this module's own location, not `process.cwd()` --
// the dev server may be started from the repo root or from `apps/web`, and
// this must find the same file either way.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(HERE, '..', '..', 'sprites.local.json');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

interface LocalSpritesConfig {
  readonly packs: Record<string, string>;
}

export interface LocalSpritesPluginOptions {
  /** Overridable so a test can point at a temp directory instead of the real repo file. */
  readonly configPath?: string;
}

/** Loose validation: a plain object with a `packs` plain object of string values. Anything else is treated as absent. */
function isValidConfig(value: unknown): value is LocalSpritesConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const packs = (value as Record<string, unknown>)['packs'];
  if (typeof packs !== 'object' || packs === null || Array.isArray(packs)) {
    return false;
  }
  return Object.values(packs).every((entry) => typeof entry === 'string');
}

function loadConfig(configPath: string): LocalSpritesConfig | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    console.warn(`localSpritesPlugin: could not read ${configPath}: ${String(error)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`localSpritesPlugin: ${configPath} is not valid JSON: ${String(error)}`);
    return undefined;
  }
  if (!isValidConfig(parsed)) {
    console.warn(`localSpritesPlugin: ${configPath} does not match { "packs": { [name]: string } }`);
    return undefined;
  }
  return parsed;
}

function noopPlugin(): Plugin {
  return {
    name: 'local-sprites',
    apply: 'serve',
  };
}

/**
 * Reads `apps/web/sprites.local.json` (or `options.configPath`) synchronously
 * at plugin-creation time. Never throws: an absent or malformed config
 * produces a no-op plugin, logged via `console.warn` in the malformed case.
 */
export function localSpritesPlugin(options: LocalSpritesPluginOptions = {}): Plugin {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  let config: LocalSpritesConfig | undefined;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.warn(`localSpritesPlugin: unexpected error reading ${configPath}: ${String(error)}`);
    config = undefined;
  }

  if (config === undefined) {
    return noopPlugin();
  }

  const packs = config.packs;

  return {
    name: 'local-sprites',
    apply: 'serve',
    configureServer(server) {
      for (const [name, root] of Object.entries(packs)) {
        const prefix = `/local-sprites/${name}/`;
        const normalizedRoot = normalize(root);
        // Trailing separator so a sibling directory sharing this root as a
        // string prefix (e.g. `hero-evil` next to `hero`) cannot pass the
        // containment check below.
        const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
        server.middlewares.use(prefix, (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
          }
          const urlPath = (req.url ?? '').split('?')[0] ?? '';
          let relative: string;
          try {
            relative = decodeURIComponent(urlPath.replace(/^\/+/, ''));
          } catch {
            res.statusCode = 400;
            res.end('Bad request');
            return;
          }
          // Refuse to walk out of the configured pack root.
          if (relative.includes('..')) {
            res.statusCode = 400;
            res.end('Bad request');
            return;
          }
          const filePath = normalize(join(root, relative));
          if (filePath !== normalizedRoot && !filePath.startsWith(rootPrefix)) {
            res.statusCode = 400;
            res.end('Bad request');
            return;
          }
          try {
            if (!statSync(filePath).isFile()) {
              next();
              return;
            }
            const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
            res.statusCode = 200;
            res.setHeader('Content-Type', type);
            res.end(readFileSync(filePath));
          } catch {
            // Deleted/permission-denied between the request and here -- treat
            // exactly like "not found", same as the pre-existing sprite loader.
            next();
          }
        });
      }
    },
  };
}
