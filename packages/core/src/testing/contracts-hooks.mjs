/**
 * Node module-resolution hooks for the cross-process half of the INV-2
 * determinism gate.
 *
 * `docs/contracts/` has no `package.json` and is not linked into
 * `node_modules` -- the bare specifier `@tokenbrawl/contracts` is a
 * `tsconfig.base.json` path alias plus a Vitest `resolve.alias`, neither of
 * which a plain `node` process knows anything about. Without these hooks a
 * child spawned to replay a Command Log dies with `ERR_MODULE_NOT_FOUND`
 * before it can import a single core module.
 *
 * Two mappings, both deliberately narrow:
 *
 * 1. `@tokenbrawl/contracts` -> `docs/contracts/index.ts`, resolved relative
 *    to *this file* rather than through an environment variable, so the hooks
 *    keep working no matter what cwd the child is spawned from and there is
 *    no ambient state to get wrong. The `format` is stated explicitly:
 *    `docs/` has no `package.json` of its own, so Node would walk up to the
 *    root manifest, find no `"type"` field, and treat the `.ts` file as
 *    CommonJS.
 *
 * 2. Extensionless relative specifiers (`./replay`, `../mock-environment`)
 *    get a `.ts` extension appended. The repo's TypeScript is written for
 *    `moduleResolution: "Bundler"`, which makes extensionless imports the
 *    house style; Node ESM requires the extension. Rewriting the source to
 *    use explicit `.ts` extensions instead would need
 *    `allowImportingTsExtensions` project-wide, changing every package to
 *    accommodate one test harness.
 */
const CONTRACTS_SPECIFIER = '@tokenbrawl/contracts';
const CONTRACTS_URL = new URL('../../../../docs/contracts/index.ts', import.meta.url).href;
/** A real JS/TS extension, tested only on the retry path -- see `resolve`. */
const JS_OR_TS_EXTENSION = /\.[cm]?[jt]sx?$/;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === CONTRACTS_SPECIFIER) {
    return { url: CONTRACTS_URL, format: 'module-typescript', shortCircuit: true };
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    // Try the specifier as written first and only append `.ts` when Node
    // cannot resolve it. Testing "does it already have an extension?" with a
    // regex gets a dotted basename wrong: `./fixtures/determinism.command-log`
    // looks extensionless to a `\.[cm]?[jt]sx?$` test only after
    // `.command-log` has already been mistaken for one, so the specifier is
    // rewritten to a path that appears nowhere in the source and fails as
    // ERR_MODULE_NOT_FOUND. Only ERR_MODULE_NOT_FOUND is retried: a directory
    // specifier raises ERR_UNSUPPORTED_DIR_IMPORT, which is rethrown as-is
    // because Node ESM has no index resolution to fall back to and
    // `./testing.ts` would be a worse error than the accurate one.
    //
    // The extension test lives on the *retry* path, never the first attempt,
    // which is what keeps it from repeating the mistake it replaced. A
    // specifier that already ends in a real JS/TS extension (`./replay.js`,
    // NodeNext house style) is not missing one, so appending `.ts` can only
    // produce `./replay.js.ts` -- a path that appears nowhere in the source,
    // reported as the error the child dies on. Rethrow the accurate original
    // instead. A dotted basename like `./fixtures/determinism.command-log` is
    // unaffected: `.command-log` is not a JS/TS extension, so it still gets
    // the `.ts` it is genuinely missing.
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || JS_OR_TS_EXTENSION.test(specifier)) {
        throw error;
      }
      return nextResolve(`${specifier}.ts`, context);
    }
  }

  return nextResolve(specifier, context);
}
