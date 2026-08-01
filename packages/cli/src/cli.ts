import process from 'node:process';

import { main } from './main';
import { createNodeIo } from './node-io';

/**
 * The executable entry point.
 *
 * Run it with:
 *
 *   npm run tokenbrawl -w packages/cli -- tournament --config <path>
 *
 * which expands to
 *
 *   node --experimental-strip-types --no-warnings --import ./bin/register.mjs \
 *        src/cli.ts tournament --config <path>
 *
 * The `--import` shim is not optional: this repo's TypeScript is written for
 * `moduleResolution: "Bundler"`, and a plain `node` cannot resolve the bare
 * `@tokenbrawl/contracts` alias, an extensionless relative import, a bare Ajv
 * subpath, or a JSON import without an attribute. `bin/register.mjs` installs
 * the hooks that close all four.
 *
 * Deliberately the thinnest file in the package, and the only one that is not
 * directly covered by a test: everything it could get wrong is in `main`,
 * which is tested exhaustively against an in-memory io. What is left here is
 * constructing the Node io and turning an exit code into an exit -- the two
 * things a test genuinely cannot do without spawning a process.
 *
 * `process.exitCode` rather than `process.exit()`: the latter truncates
 * pending stdout writes on some platforms, which would drop the last line of a
 * tournament summary. Setting the code lets Node flush and exit on its own.
 */
const argv = process.argv.slice(2);

process.exitCode = await main(argv, createNodeIo());
