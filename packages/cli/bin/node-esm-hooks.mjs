/**
 * The two Node resolution gaps `contracts-hooks.mjs` does not cover.
 *
 * Story 1.4's hooks handle the repo's own specifiers -- the bare
 * `@tokenbrawl/contracts` alias, and extensionless *relative* imports. That
 * was everything the cross-process replay child needed, because
 * `packages/core/src/replay.ts` is deliberately dependency-starved.
 *
 * The CLI is not. It reaches `packages/core/src/command-log.ts`, which does
 * two more things Node ESM rejects and a bundler accepts:
 *
 * 1. `import Ajv2020 from 'ajv/dist/2020'` -- a bare package subpath with no
 *    extension. Node wants `ajv/dist/2020.js`.
 * 2. `import schema from '.../command-log.schema.json'` -- legal under
 *    `resolveJsonModule`, and rejected by Node without an explicit
 *    `with { type: 'json' }` import attribute.
 *
 * Both are fixed here rather than in the source, because the source is written
 * for `moduleResolution: "Bundler"` and every other consumer -- Vitest, Vite,
 * tsc -- resolves it correctly as written. Changing core to suit one runner
 * would break the other four.
 *
 * A separate module rather than an edit to `contracts-hooks.mjs`, on purpose:
 * that file is load-bearing for the INV-2 determinism gate, and a change there
 * to serve a CLI would put a gate at risk for a convenience. Node chains
 * registered hooks, so the two compose with no coupling at all.
 *
 * The retry discipline is copied from the file it sits beside: the specifier
 * is tried as written first, and `.js` is appended only after Node itself has
 * said ERR_MODULE_NOT_FOUND. A specifier already ending in a real JS extension
 * is never rewritten -- appending could only produce a path that exists
 * nowhere, replacing an accurate error with a confusing one.
 */

const RELATIVE = /^\.{1,2}\//;
const JS_EXTENSION = /\.[cm]?jsx?$/;

/** JSON imported as a module needs the attribute stated, or Node refuses to load it. */
function withJsonAttribute(resolved) {
  if (!resolved.url.startsWith('file:') || !resolved.url.endsWith('.json')) {
    return resolved;
  }
  return { ...resolved, format: 'json', importAttributes: { type: 'json' } };
}

export async function resolve(specifier, context, nextResolve) {
  const bareAndExtensionless =
    !RELATIVE.test(specifier) && !specifier.startsWith('node:') && !JS_EXTENSION.test(specifier);

  try {
    return withJsonAttribute(await nextResolve(specifier, context));
  } catch (error) {
    if (!bareAndExtensionless || error?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    return withJsonAttribute(await nextResolve(`${specifier}.js`, context));
  }
}
