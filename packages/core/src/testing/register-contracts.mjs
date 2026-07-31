/**
 * `--import` shim that installs `./contracts-hooks.mjs`.
 *
 * Node's `--experimental-loader` is deprecated in favour of registering hooks
 * from inside the main thread, which is what `node:module`'s `register` does.
 * Spawn shape:
 *
 *   node --experimental-strip-types --no-warnings \
 *        --import <file:// URL of this file> replay-child.ts <log.json>
 *
 * The `--import` argument MUST be a `file://` URL, not a bare path: on
 * Windows a `C:\...` path is rejected with `ERR_UNSUPPORTED_ESM_URL_SCHEME`
 * because `C:` parses as a URL scheme. Callers should build it with
 * `pathToFileURL(...).href`.
 */
import { register } from 'node:module';

register(new URL('./contracts-hooks.mjs', import.meta.url));
