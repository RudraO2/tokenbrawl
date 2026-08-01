import process from 'node:process';

import { main } from './main';
import { createNodeIo } from './node-io';

/**
 * The executable entry point.
 *
 * Run it **from the repository root** with:
 *
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs packages/cli/src/cli.ts \
 *        tournament --config configs/tournament.config.json
 *
 * Not via `npm run tokenbrawl -w packages/cli -- ...`, which this comment
 * recommended until Story 5.3 ran it on a real machine and found two defects
 * in it, neither visible to a unit test:
 *
 *   1. npm consumes `--config` and `--dry-run` even after `--`, because both
 *      are npm's own flags. The CLI receives `tournament <path>` with the
 *      options stripped and exits 2 on "Unexpected argument".
 *   2. `-w packages/cli` sets cwd to `packages/cli`, so a config's relative
 *      `outputDir` resolves under that directory instead of the repository
 *      root -- silently writing Command Logs where nothing looks for them.
 *
 * Both are avoided by invoking node directly from the root, which is what
 * `.github/workflows/tournament.yml` does. The `tokenbrawl` package script is
 * kept for convenience on commands that use neither flag.
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
