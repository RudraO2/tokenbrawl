import type { HttpFetch } from './http';
import { defaultHttpFetch } from './http';

/**
 * Story 4.7: ask the provider what models this key can actually use.
 *
 * A curated list is stale the day it lands -- models turn over weekly and no
 * committed file tracks that. Every provider in this build serves a plain
 * `GET .../models`, so the picker can be populated from the visitor's own
 * account instead of from a file somebody updated last epoch.
 *
 * The security property AC4 asks for is *one origin*, and it is guaranteed here
 * by construction rather than by care: the discovery URL is **derived from the
 * completions endpoint** the key was already going to be sent to, and then
 * checked against it. There is no second URL anyone can configure, and no place
 * a provider name is mapped to a hostname a second time.
 *
 * Measured by CORS preflight 2026-08-01, recorded in
 * `docs/reports/byok-cors-preflight.md`: all four model-list endpoints answer a
 * cross-origin preflight with the auth header allowed, so this runs in a tab.
 */

/**
 * Two wire shapes, not one per provider.
 *
 * `openai` covers Groq, Cerebras, OpenRouter, xAI, OpenAI itself and every
 * OpenAI-compatible gateway a visitor points Advanced mode at: `{ data: [{ id }] }`
 * behind `/v1/models`. `google` is `{ models: [{ name: "models/<id>" }] }` behind
 * `/v1beta/models`. Keying on the shape rather than on the vendor is what stops
 * this file growing a branch per provider.
 */
export type ModelListFamily = 'openai' | 'google';

const OPENAI_COMPLETIONS_SUFFIX = '/chat/completions';
const GOOGLE_MODELS_SEGMENT = '/models/';

interface OpenAiModelList {
  readonly data?: readonly { readonly id?: unknown }[] | null;
}

interface GoogleModelList {
  readonly models?: readonly { readonly name?: unknown }[] | null;
}

/** Enough of a failing body to diagnose it, never enough to flood a log. */
const BODY_EXCERPT_LIMIT = 256;

function excerpt(bodyText: string): string {
  return bodyText.length > BODY_EXCERPT_LIMIT
    ? `${bodyText.slice(0, BODY_EXCERPT_LIMIT)}...`
    : bodyText;
}

/**
 * The three fields this package reads off a parsed URL.
 *
 * Declared structurally and reached through `globalThis`, exactly as
 * `defaultHttpFetch` reaches `fetch`, and for the same reason:
 * `tsconfig.base.json` sets `lib: ["ES2022"]` with no DOM, so naming the
 * ambient `URL` type would bind this package to whichever declaration happens
 * to be installed -- today that is `@types/node`, in a package that must run in
 * a browser (AD-4). `URL` is a web-platform global present in both runtimes;
 * only its *type* is the problem, and this is the house answer to that.
 */
export interface ParsedUrl {
  readonly origin: string;
  readonly protocol: string;
  readonly pathname: string;
}

type UrlConstructor = new (input: string) => ParsedUrl;

export function parseUrl(input: string): ParsedUrl {
  const candidate = (globalThis as unknown as { URL?: unknown }).URL;
  if (typeof candidate !== 'function') {
    throw new Error('No global URL is available. This build needs a browser or Node 18 or newer.');
  }
  try {
    return new (candidate as UrlConstructor)(input);
  } catch {
    throw new Error(`Not a URL: ${excerpt(input)}`);
  }
}

/** Scheme + host + port, with no trailing path. The unit AC4's "one origin" is measured in. */
export function originOf(url: string): string {
  return parseUrl(url).origin;
}

/**
 * The model-list URL for a completions endpoint.
 *
 * Derived rather than configured, so the two cannot point at different hosts:
 * a provider table with a `modelsUrl` column beside an `endpoints` column is one
 * typo away from sending a key somewhere the allowlist never approved.
 */
export function modelListEndpointFor(completionEndpoint: string, family: ModelListFamily): string {
  const derived = deriveModelListEndpoint(completionEndpoint, family);

  // Belt and braces, and cheap. If a future edit makes the derivation clever
  // enough to change host, this is what catches it before a key moves.
  if (originOf(derived) !== originOf(completionEndpoint)) {
    throw new Error(
      `Model discovery for "${completionEndpoint}" resolved to a different origin (${originOf(derived)}). A key is only ever sent to one origin.`,
    );
  }

  return derived;
}

function deriveModelListEndpoint(completionEndpoint: string, family: ModelListFamily): string {
  if (family === 'openai') {
    if (!completionEndpoint.endsWith(OPENAI_COMPLETIONS_SUFFIX)) {
      throw new Error(
        `Cannot derive a model list for "${completionEndpoint}": an OpenAI-compatible completions URL ends with ${OPENAI_COMPLETIONS_SUFFIX}.`,
      );
    }
    return `${completionEndpoint.slice(0, -OPENAI_COMPLETIONS_SUFFIX.length)}/models`;
  }

  // Google addresses a model by path -- `/v1beta/models/<id>:generateContent` --
  // so the collection is the same URL with the model and verb cut off.
  const segment = completionEndpoint.lastIndexOf(GOOGLE_MODELS_SEGMENT);
  if (segment === -1) {
    throw new Error(
      `Cannot derive a model list for "${completionEndpoint}": a Google AI Studio URL contains ${GOOGLE_MODELS_SEGMENT}.`,
    );
  }
  return `${completionEndpoint.slice(0, segment)}/models`;
}

/**
 * Provider body text -> model ids. Pure, so every shape is testable from a
 * recorded response with no network and no key.
 *
 * A malformed entry is skipped rather than thrown on: one unusable row in a
 * list of two hundred is not a reason to refuse the other one hundred and
 * ninety-nine. A body that is not a model list at all *is* thrown on, because
 * silently returning an empty list would look identical to "this key can use
 * nothing", which is a very different thing to tell a visitor.
 */
export function mapModelList(family: ModelListFamily, bodyText: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Model list is not JSON: ${excerpt(bodyText)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Model list is not an object: ${excerpt(bodyText)}`);
  }

  const rows =
    family === 'openai' ? (parsed as OpenAiModelList).data : (parsed as GoogleModelList).models;

  if (!Array.isArray(rows)) {
    throw new Error(
      `Model list carries no ${family === 'openai' ? 'data' : 'models'} array: ${excerpt(bodyText)}`,
    );
  }

  const ids: string[] = [];
  for (const row of rows) {
    const raw = family === 'openai' ? row.id : row.name;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      continue;
    }
    // Google prefixes every id with `models/`. The rest of the app names a
    // model the way a request body does, so the prefix comes off here rather
    // than in three places downstream.
    const id = family === 'google' && raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
    ids.push(id);
  }

  return Object.freeze([...new Set(ids)].sort());
}

export interface DiscoverModelsConfig {
  /** The URL this key would be sent a completion on. Discovery is derived from it and never diverges. */
  readonly completionEndpoint: string;
  readonly family: ModelListFamily;
  readonly apiKey: string;
  /** `Authorization` or `x-goog-api-key`, matching the adapter that will run the Match. */
  readonly keyHeader: string;
  readonly fetch?: HttpFetch;
}

/**
 * One GET, one origin, no retry.
 *
 * No retry for the same reason a Match call never retries (INV-1): a failed
 * discovery is information the visitor should see, and a second automatic
 * request against a key that was just rejected is how a rate limit becomes a
 * lockout.
 */
export async function discoverModels(config: DiscoverModelsConfig): Promise<readonly string[]> {
  if (config.apiKey.trim().length === 0) {
    throw new Error('A key is needed to ask a provider which models it will serve.');
  }

  const endpoint = modelListEndpointFor(config.completionEndpoint, config.family);
  const httpFetch = config.fetch ?? defaultHttpFetch();

  const value =
    config.keyHeader.toLowerCase() === 'authorization' ? `Bearer ${config.apiKey}` : config.apiKey;

  const response = await httpFetch(endpoint, {
    method: 'GET',
    headers: { [config.keyHeader]: value },
  });

  const bodyText = await response.text();

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Model list request to ${endpoint} failed with status ${String(response.status)}: ${excerpt(bodyText)}`,
    );
  }

  return mapModelList(config.family, bodyText);
}
