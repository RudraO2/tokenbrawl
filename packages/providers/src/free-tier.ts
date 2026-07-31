import rawFreeTierConfig from './free-tier.config.json';

/**
 * Story 3.2: free-tier quotas and the endpoint allowlist, read from
 * `free-tier.config.json`.
 *
 * AC5 says the limits come from a config file rather than from constants in
 * code, and INV-8 says a paid endpoint must fail configuration validation.
 * Those are the same requirement seen from two sides, so they share one file:
 * the allowlist *is* the free-tier record, and an endpoint that is not on it
 * cannot be configured at all.
 *
 * Nothing here caches. `loadFreeTierConfig()` validates on every call and
 * returns a fresh frozen structure -- a module-level memo would be exactly the
 * cross-call state AC3 forbids the adapter to hold, and the cost of revalidating
 * a twenty-line document is not worth the exception.
 */

export interface FreeTierLimits {
  readonly requestsPerMinute: number;
  readonly requestsPerDay: number;
  readonly tokensPerMinute: number;
}

export interface FreeTierProvider {
  /** Every endpoint this provider may be configured with. Anything else is rejected (INV-8). */
  readonly endpoints: readonly string[];
  /** Backoff used only when a rate-limit response carries no timing header at all. */
  readonly fallbackBackoffMs: number;
  /** Applied to any model without its own entry below. */
  readonly defaults: FreeTierLimits;
  readonly models: Readonly<Record<string, FreeTierLimits>>;
}

export interface FreeTierConfig {
  /** The date the numbers below were last checked against the provider's published limits. */
  readonly verifiedOn: string;
  readonly providers: Readonly<Record<string, FreeTierProvider>>;
}

const LIMIT_FIELDS = ['requestsPerMinute', 'requestsPerDay', 'tokensPerMinute'] as const;

function fail(detail: string): never {
  throw new Error(`free-tier.config.json is malformed: ${detail}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Every quota is a positive safe integer. Zero is rejected as loudly as a
 * negative: a quota of zero would silently mean "this Deployment may never be
 * called", which is a config typo, not a policy anyone would express this way.
 */
function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${where} must be a positive safe integer, got ${String(value)}`);
  }
  return value as number;
}

function validateLimits(value: unknown, where: string): FreeTierLimits {
  const record = asRecord(value, where);
  const limits: Record<string, number> = {};
  for (const field of LIMIT_FIELDS) {
    limits[field] = positiveInteger(record[field], `${where}.${field}`);
  }
  return Object.freeze(limits as unknown as FreeTierLimits);
}

function validateProvider(value: unknown, name: string): FreeTierProvider {
  const record = asRecord(value, `providers.${name}`);

  const endpoints = record.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    fail(`providers.${name}.endpoints must be a non-empty array`);
  }
  for (const endpoint of endpoints) {
    // `https://` and nothing else: a plaintext endpoint would put the API key
    // on the wire in clear, and a relative one cannot be an upstream provider.
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
      fail(`providers.${name}.endpoints entries must be https:// URLs, got ${String(endpoint)}`);
    }
  }

  const models = asRecord(record.models, `providers.${name}.models`);
  const validatedModels: Record<string, FreeTierLimits> = {};
  for (const model of Object.keys(models)) {
    validatedModels[model] = validateLimits(models[model], `providers.${name}.models.${model}`);
  }

  return Object.freeze({
    endpoints: Object.freeze([...(endpoints as string[])]),
    fallbackBackoffMs: positiveInteger(
      record.fallbackBackoffMs,
      `providers.${name}.fallbackBackoffMs`,
    ),
    defaults: validateLimits(record.defaults, `providers.${name}.defaults`),
    models: Object.freeze(validatedModels),
  });
}

/**
 * Reads and validates the committed config. Throws rather than repairing: a
 * quota that fails validation is a typo in a file nobody re-reads, and a
 * silently defaulted one would pace a whole tournament against a number that
 * was never written down.
 *
 * `source` defaults to the committed file. It is a parameter so that a
 * caller-supplied config goes through exactly the same validation -- an
 * injected document that skipped it would be the one path by which an
 * unvalidated endpoint could reach a request (INV-8).
 */
export function loadFreeTierConfig(source: unknown = rawFreeTierConfig): FreeTierConfig {
  const root = asRecord(source, 'root');

  if (typeof root.verifiedOn !== 'string' || root.verifiedOn.trim().length === 0) {
    fail('verifiedOn must be a non-empty string');
  }

  const providers = asRecord(root.providers, 'providers');
  const names = Object.keys(providers);
  if (names.length === 0) {
    fail('providers must not be empty');
  }

  const validated: Record<string, FreeTierProvider> = {};
  for (const name of names) {
    validated[name] = validateProvider(providers[name], name);
  }

  return Object.freeze({
    verifiedOn: root.verifiedOn,
    providers: Object.freeze(validated),
  });
}

export function freeTierProvider(
  provider: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): FreeTierProvider {
  const entry = config.providers[provider];
  if (entry === undefined) {
    throw new Error(
      `No free-tier configuration for provider "${provider}". Add it to free-tier.config.json before configuring a Deployment against it (INV-8).`,
    );
  }
  return entry;
}

/**
 * The quotas for one Deployment. A model without its own entry inherits the
 * provider's `defaults`, which are deliberately the *tighter* published numbers:
 * pacing an unknown model against the workhorse model's allowance is how a
 * tournament burns a day's quota in an hour.
 */
export function freeTierLimitsFor(
  provider: string,
  model: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): FreeTierLimits {
  const entry = freeTierProvider(provider, config);
  return entry.models[model] ?? entry.defaults;
}

/**
 * INV-8's machine check, at the only point where it can be enforced: an
 * endpoint that is not on the provider's free-tier allowlist is refused before
 * a single request is made. There is no override parameter, because "just this
 * once" is how a recurring cost starts.
 */
export function assertFreeTierEndpoint(
  provider: string,
  endpoint: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): void {
  const entry = freeTierProvider(provider, config);
  if (!entry.endpoints.includes(endpoint)) {
    throw new Error(
      `Endpoint "${endpoint}" is not on the free-tier allowlist for provider "${provider}" (INV-8: zero recurring cost). Allowed: ${entry.endpoints.join(', ')}`,
    );
  }
}
