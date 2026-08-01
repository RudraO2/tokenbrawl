# Tokenbrawl leaderboard

**Generated artefact — do not hand-edit.** Regenerate with `tokenbrawl leaderboard --config configs/tournament.config.json`.

A rating is the Agent’s mean score over its rated Matches — a win is a whole point, a draw
half of one — with a seeded percentile bootstrap interval beside it. Ratings are comparable
only within a table, and only as far as the two Agents met comparable opposition, so the
opponent count and the full per-opponent breakdown are published with every row.

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `891e524089af5b88da76fcfb9149be945cb0d33738d2eda472498475180b48a2`
- Corpus: 1 committed Command Log from `apps/web/public/replays`
- Matches: 1 total, 0 rated, 1 excluded
- Confidence interval: seeded percentile bootstrap, 2000 resamples, seed 20260802, 0.9500 coverage (AD-5)

## Main leaderboard

_No rated entry on the main leaderboard. Every Deployment needs a Metering Probe result of `reports-reasoning` to appear here (INV-5)._

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

_No rated entrant, so nothing to report behaviour for._

## Not rated

| Entrant | Kind | Track | Why |
| --- | --- | --- | --- |
| bot:aggressive | bot | main | No rated Match: every Match this Agent played was excluded (BYOK, or a pairing below the coverage floor). |
| bot:spacing | bot | main | No rated Match: every Match this Agent played was excluded (BYOK, or a pairing below the coverage floor). |

## Pairing coverage

A pairing is rated only once it has been played enough, from both sides; below either floor it
is provisional and contributes to no rating (Story 7-1, AC3).

| Pairing | Matches | On side 0 | Mirrored seeds | Rated |
| --- | --- | --- | --- | --- |
| bot:aggressive vs bot:spacing | 1 | 1 / 0 | 0 | provisional (insufficient-matches, insufficient-mirrored-seeds) |

## Excluded Matches

Counted per reason, so a Match excluded twice over appears under both; the column does not sum
to the total above.

| Reason | Matches |
| --- | --- |
| insufficient-matches | 1 |
| insufficient-mirrored-seeds | 1 |
