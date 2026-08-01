/**
 * `--import` shim for running `src/cli.ts` under a plain `node`.
 *
 * Two things in this repo's source are invisible to Node's own resolver: the
 * bare `@tokenbrawl/contracts` specifier (a `tsconfig` path alias plus a
 * Vitest alias, and `docs/contracts/` is not linked into `node_modules`), and
 * extensionless relative imports (the house style under
 * `moduleResolution: "Bundler"`). Story 1.4 already solved both, for the
 * cross-process determinism child, in `contracts-hooks.mjs`.
 *
 * So this registers *that* module rather than carrying a second copy of the
 * mapping. A second resolver would be exactly the fork Story 5.1's first
 * acceptance criterion forbids, and it would drift the first time one of them
 * learned about a new extension. The hooks file lives under core's `testing/`
 * because that is where its first consumer was; it is a build-tooling module,
 * not a test, and it is loaded here through a command-line flag rather than by
 * any shipped import.
 *
 * Invoked by `npm run tokenbrawl -w packages/cli`, which is the supported way
 * to run the CLI:
 *
 *   node --experimental-strip-types --no-warnings \
 *        --import ./bin/register.mjs src/cli.ts tournament --config <path>
 */
import { register } from 'node:module';

register(new URL('../../core/src/testing/contracts-hooks.mjs', import.meta.url));
// And one more for the two things core's Command Log module needs that the
// dependency-starved replay child never reaches: a bare Ajv subpath, and a
// JSON import attribute. See that file for why it is not an edit to the one
// above.
register(new URL('./node-esm-hooks.mjs', import.meta.url));
