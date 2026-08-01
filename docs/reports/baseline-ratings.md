# Baseline Bot ratings

**Generated artefact — do not hand-edit.** Regenerate with `TOKENBRAWL_WRITE_RATINGS_REPORT=1 npx vitest run --root packages/env-fighter src/ratings.test.ts`.

A rating is the Agent’s mean score over its rated Matches — a win is a whole point, a draw
half of one — with a seeded percentile bootstrap interval beside it. Ratings are comparable
only within a table, and only as far as the two Agents met comparable opposition, so the
opponent count and the full per-opponent breakdown are published with every row.

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `891e524089af5b88da76fcfb9149be945cb0d33738d2eda472498475180b48a2`
- Corpus: the Baseline Bot ladder — 600 Matches over 100 seeds from seed base 20260731, every seed played from both sides (AD-12)
- Matches: 600 total, 600 rated, 0 excluded
- Confidence interval: seeded percentile bootstrap, 2000 resamples, seed 20260802, 0.9500 coverage (AD-5)

## Main leaderboard

| Agent | Kind | Matches | Opponents | Rating | CI |
| --- | --- | --- | --- | --- | --- |
| spacing-aware | bot | 400 | 2 | 0.9325 | 0.9075 – 0.9550 |
| aggressive | bot | 400 | 2 | 0.5050 | 0.4575 – 0.5562 |
| random | bot | 400 | 2 | 0.0625 | 0.0412 – 0.0862 |

## Reflex Track

Separate by construction, and never merged into the table above (INV-5, AD-11). A Deployment
lands here when its Metering Probe did not report a separate deliberation count, so its Token
Bank cannot be debited honestly — its Matches are still played and still published.

_No Reflex-Track entry in this corpus._

## Pairing coverage

A pairing is rated only once it has been played enough, from both sides; below either floor it
is provisional and contributes to no rating (Story 7-1, AC3).

| Pairing | Matches | On side 0 | Mirrored seeds | Rated |
| --- | --- | --- | --- | --- |
| aggressive vs random | 200 | 100 / 100 | 100 | yes |
| aggressive vs spacing-aware | 200 | 100 / 100 | 100 | yes |
| random vs spacing-aware | 200 | 100 / 100 | 100 | yes |
