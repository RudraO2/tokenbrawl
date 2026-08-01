# Provider free-tier limits, as measured from live dashboards

Captured 2026-08-01 from the project owner's own provider dashboards, not from
documentation and not from a blog. Where a provider publishes per-account limits
(Google), these are that account's numbers and another account may differ — the
*shape* of the constraint is what matters here, and it is stable.

This file exists because Story 4.6 shipped a picker built on four models chosen
from a config file, and two of the four choices turn out to be bad ones. Stories
4.7 and 4.8 are built from the table below.

## The number that actually binds: a Match is ~60 calls

Up to two provider calls per Decision Point, roughly thirty Decision Points, minus
every point where a fighter is inside a Commitment Window and is not polled. Call
it **60 calls worst case, ~45 typical**.

So **RPD decides whether a fight can finish at all**, and **TPM decides how long
it takes**. RPM is rarely the binding constraint. Read every row below that way.

## Groq (`api.groq.com/openai/v1/chat/completions`)

Free plan. Chat models only; speech and guard models omitted.

| Model | RPM | RPD | TPM | TPD | Matches/day (RPD ÷ 60) | Minutes/match (TPM ÷ ~1K per call) |
|---|---|---|---|---|---|---|
| `llama-3.1-8b-instant` | 30 | 14,400 | 6K | 500K | **240** | ~10 |
| `llama-3.3-70b-versatile` | 30 | 1,000 | 12K | 100K | 16 | ~5 |
| `openai/gpt-oss-120b` | 30 | 1,000 | 8K | 200K | 16 | ~7.5 |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8K | 200K | 16 | ~7.5 |
| `openai/gpt-oss-safeguard-20b` | 30 | 1,000 | 8K | 200K | 16 | ~7.5 |
| `qwen/qwen3.6-27b` | 30 | 1,000 | 8K | 200K | 16 | ~7.5 |
| `groq/compound` | 30 | 250 | 70K | — | 4 | ~1 |
| `groq/compound-mini` | 30 | 250 | 70K | — | 4 | ~1 |

Notes:

- **No Gemma on Groq.** An earlier web search suggested `gemma2-9b-it` at 15K TPM;
  the owner's own dashboard does not list it. Treat it as gone.
- `openai/gpt-oss-*` are OpenAI's open-weight models, free, with no OpenAI
  account. This is how "add OpenAI" is satisfied at zero cost.
- TPM is the binding constraint on every row. RPM of 30 is never reached.

### Groq rate-limit headers — the basis for pacing

Present on **every** response, not only on a 429:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit-requests` | Requests per **day** |
| `x-ratelimit-limit-tokens` | Tokens per **minute** |
| `x-ratelimit-remaining-requests` | RPD remaining |
| `x-ratelimit-remaining-tokens` | TPM remaining |
| `x-ratelimit-reset-requests` | e.g. `2m59.56s` |
| `x-ratelimit-reset-tokens` | e.g. `7.66s` |
| `retry-after` | Seconds. **Only** on a 429. |

That every-response availability is what makes proactive pacing possible: a
runner can see it is about to run out of tokens-per-minute and slow down
*before* a 429, rather than absorbing one and recovering. Story 4.8.

## Google AI Studio (`generativelanguage.googleapis.com`)

From the owner's AI Studio rate-limit dashboard. Only models usable for text
generation are listed; image, video, audio, embedding, robotics and agent rows
are omitted as irrelevant to a fighting Match.

| Model | RPM | TPM | RPD | Matches/day | Verdict |
|---|---|---|---|---|---|
| **Gemma 4 31B** | **30** | 16K | **14,400** | **240** | best on this provider |
| **Gemma 4 26B** | **30** | 16K | **14,400** | **240** | best on this provider |
| Gemini 3.1 Flash Lite | 15 | 250K | 500 | 8 | usable |
| Gemini 3.5 Flash Lite | 15 | 250K | 500 | 8 | usable |
| Gemini 2.5 Flash Lite | 10 | 250K | 20 | **0** | cannot finish one Match |
| Gemini 2.5 Flash | 5 | 250K | 20 | **0** | cannot finish one Match |
| Gemini 3 Flash | 5 | 250K | 20 | **0** | cannot finish one Match |
| Gemini 3.5 Flash | 5 | 250K | 20 | **0** | cannot finish one Match |
| Gemini 3.6 Flash | 5 | 250K | 20 | **0** | cannot finish one Match |
| Gemini 2.5 Pro / 3.1 Pro | 0 | 0 | 0 | 0 | no free quota on this account |

**The finding that changes the picker.** Story 4.6 offers `gemini-2.5-flash` and
`gemini-2.5-pro`. The first has a 20-request *daily* cap against a 60-call
Match — it can never complete one. The second has no free quota at all. Both are
in `free-tier.config.json` today. Meanwhile the two Gemma models, which are not
offered, are the strongest free option anywhere in this table: 30 RPM and 14,400
RPD, matching Groq's best.

Google bakes the model into the URL path, so each model is its own allowlist
entry — adding these is a config change, not an adapter change.

## Cerebras (`api.cerebras.ai/v1/chat/completions`)

| Model | RPM | TPM | TPH | TPD |
|---|---|---|---|---|
| `gpt-oss-120b` | 5 | 30K | 1M | 1M |
| `zai-glm-4.7` | 5 | 30K | 1M | 1M |
| `gemma-4-31b` | 5 | 30K | 1M | 1M |

**`free-tier.config.json` is wrong about this provider.** It records 30 RPM
(defaults and `llama3.1-8b`), verified 2026-08-01. The dashboard says **5 RPM**
— a six-fold overstatement — and does not list `llama3.1-8b` at all. At 5 RPM a
60-call Match takes a minimum of **twelve minutes**, which is a fact the picker
must state rather than discover halfway through.

Fixing those numbers is a task of Story 4.7. They were left unedited by 4.6
deliberately: the story that owns a file's correctness should be the one that
changes it, and a "verified" number should move with a dated source beside it.

## OpenAI, Anthropic, and everyone else

No free tier. They cannot be reached by adding an allowlist entry, because there
is no free endpoint to allowlist.

They are reachable by a different route, and the project owner has decided
twice, explicitly, that they should be: **an Advanced mode where the visitor
supplies base URL, key and model name themselves.** Any OpenAI-compatible
endpoint then works — OpenAI, Together, Fireworks, DeepInfra, a local
llama.cpp server, an internal gateway — with no adapter per vendor and no list
for this repo to maintain.

See Story 4.7 for the invariant reading that permits it and the guard rails it
carries.

## How to refresh this file

Every number here came from a dashboard, and dashboards are the only honest
source for two of the three providers. Re-capture at the start of each epic, or
whenever a Match starts failing on quota in a way the table does not predict.
Update `free-tier.config.json`'s `verifiedOn` in the same commit.
