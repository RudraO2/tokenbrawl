# BYOK browser access, by CORS preflight

Story 4.6's scope says: *"Verify CORS support per provider before offering it in
the picker."* This is that verification, and its evidence.

A CORS preflight needs no API key, so every verdict below is reproducible by
anyone with `curl` and costs nothing. The request is the one the browser would
actually make before a BYOK call: `OPTIONS` on the endpoint the adapter uses,
carrying `Origin`, `Access-Control-Request-Method: POST`, and **the exact auth
header that provider's adapter sends** — `authorization` for the
OpenAI-compatible adapters, `x-goog-api-key` for Google AI Studio, which is
what `packages/providers/src/google.ts` puts the key on.

## Method

```sh
curl -s -i -X OPTIONS "<endpoint>" \
  -H "Origin: https://tokenbrawl.example" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: <auth-header>,content-type"
```

A provider passes if the response is 2xx **and** carries both
`access-control-allow-origin` (either `*` or the echoed origin) and an
`access-control-allow-headers` that includes the auth header. Anything else
means the call cannot be made from a browser and the provider is CLI-only.

## Results, measured 2026-08-01

| Provider | Endpoint | Auth header | Status | `allow-origin` | `allow-headers` | Verdict |
|---|---|---|---|---|---|---|
| Groq | `api.groq.com/openai/v1/chat/completions` | `authorization` | 204 | `*` | `authorization,content-type` | **browser** |
| Cerebras | `api.cerebras.ai/v1/chat/completions` | `authorization` | 200 | `*` | `authorization,content-type` | **browser** |
| Google AI Studio | `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` | `x-goog-api-key` | 200 | echoes the origin | `x-goog-api-key,content-type` | **browser** |
| OpenRouter | `openrouter.ai/api/v1/chat/completions` | `authorization` | 204 | `*` | wide allowlist including `Authorization` | CLI only — **no browser adapter in this build** |
| xAI | `api.x.ai/v1/chat/completions` | `authorization` | 200 | `*` | `*` | CLI only — **no browser adapter in this build** |

## What this means for the picker

Every provider that has an adapter in this build is reachable from a browser, so
**CORS is not what makes anything CLI-only today**. The two CLI-only entries are
CLI-only for the other reason: no adapter and no free-tier allowlist entry
exists for them. OpenRouter's free tier is 50 requests a day and
`packages/providers/src/tournament-config.ts` reserves it for the Metering
Probe; xAI has no free-tier endpoint on the allowlist at all.

`apps/web/src/byok/catalogue.ts` records one verdict per provider with its own
reason text, because from the picker's side the two causes are the same fact —
it cannot run here, so it must not be offerable here, and the visitor must be
told before pasting a key rather than after a request fails (AC5).

A third cause is enforced in the same place: a provider whose
`free-tier.config.json` entry lists no model is also refused, because a
selectable provider with an empty model list fails at request time, which is
precisely what AC5 exists to prevent.

## When to re-run this

When `free-tier.config.json`'s `verifiedOn` moves, and whenever a provider is
added. A provider that starts refusing cross-origin requests becomes `cli-only`
in the catalogue and nothing else in the app changes.
