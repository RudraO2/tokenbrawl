# Baseline Bot ratings

**Generated artefact — do not hand-edit.** Regenerate with `TOKENBRAWL_WRITE_RATINGS_REPORT=1 npx vitest run --root packages/env-fighter src/ratings.test.ts`.

A rating is the Agent’s mean score over its rated Matches — a win is a whole point, a draw
half of one — with a seeded percentile bootstrap interval beside it. Ratings are comparable
only within a table, and only as far as the two Agents met comparable opposition, so the
opponent count and the full per-opponent breakdown are published with every row.

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `24f5f97e1c88a3f3a9b66405c569c076ba30994ac93dbc69429c3b8780bdc0f7`
- Corpus: the Baseline Bot ladder — 600 Matches over 100 seeds from seed base 20260731, every seed played from both sides (AD-12)
- Matches: 600 total, 600 rated, 0 excluded
- Confidence interval: seeded percentile bootstrap, 2000 resamples, seed 20260802, 0.9500 coverage (AD-5)

## Main leaderboard

| Agent | Kind | Matches | Opponents | Rating | CI |
| --- | --- | --- | --- | --- | --- |
| spacing-aware | bot | 400 | 2 | 1.0000 | 1.0000 – 1.0000 |
| aggressive | bot | 400 | 2 | 0.4862 | 0.4400 – 0.5350 |
| random | bot | 400 | 2 | 0.0137 | 0.0037 – 0.0262 |

## Reflex Track

Separate by construction, and never merged into the table above (INV-5, AD-11). A Deployment
lands here when its Metering Probe did not report a separate deliberation count, so its Token
Bank cannot be debited honestly — its Matches are still played and still published.

_No Reflex-Track entry in this corpus._

## How the tokens were spent

Behaviour, not skill. These figures come from the same Matches as the ratings above and
say how each entrant played rather than how often it won — a benchmark that published only a
win rate would be hiding most of what it measured.

- **Parse failures** count every Decision Point that fell back to `stand`. This is a *measurement* of how
  a model behaves under a strict, published Action grammar that is identical for every entrant. It is
  not a fault to be driven down, and no entrant is penalised, filtered or footnoted for having one.
- **Rate-limited** is the part of that column the provider refused rather than the model fumbled,
  recognised from the refusal body the log kept verbatim. The two are published side by side because a
  Command Log cannot tell them apart on its own, and reporting only the total would overstate the model.
- **not reported** means exactly that: the provider never reported the quantity. It is never written as a
  zero, because "did not say" and "said none" are different findings and INV-5 turns on the difference.

| Entrant | Kind | Track | Tokens / Match | Reasoning share | Parse failures | Rate-limited | Bank exhausted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spacing-aware | bot | main | not reported | not reported | not reported | not reported | not reported |
| aggressive | bot | main | not reported | not reported | not reported | not reported | not reported |
| random | bot | main | not reported | not reported | not reported | not reported | not reported |

## Pairing coverage

A pairing is rated only once it has been played enough, from both sides; below either floor it
is provisional and contributes to no rating (Story 7-1, AC3).

| Pairing | Matches | On side 0 | Mirrored seeds | Rated |
| --- | --- | --- | --- | --- |
| aggressive vs random | 200 | 100 / 100 | 100 | yes |
| aggressive vs spacing-aware | 200 | 100 / 100 | 100 | yes |
| random vs spacing-aware | 200 | 100 / 100 | 100 | yes |
