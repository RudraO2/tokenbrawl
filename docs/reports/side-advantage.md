# Side advantage

**Generated artefact — do not hand-edit.** `packages/env-fighter/src/side-advantage.test.ts`
recomputes this file from a fresh ladder run on every `npm test` and fails if it drifts.

Verdict: **no side advantage detected**

Side 0 (P1) scores 0.4900 across 300 mirrored pairs, an advantage of **-0.0100** against the side-neutral 0.5000.
The 0.9500 interval is 0.4683 – 0.5116, which contains 0.5000.

## How this is measured

Within one mirrored pair — the same two Agents, the same seed, swapped — each Agent
plays each side exactly once, so skill cancels and what is left is the side. The pair
scores the mean of its two Matches from side 0’s point of view; a side-neutral
Environment averages exactly 0.5000 over those pairs.

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `891e524089af5b88da76fcfb9149be945cb0d33738d2eda472498475180b48a2`
- Corpus: the Baseline Bot ladder — 600 Matches over 100 seeds from seed base 20260731, every seed played from both sides (AD-12)
- Matches in no complete mirrored pair, and therefore excluded: 0
- Confidence interval: seeded percentile bootstrap over *pairs*, 2000 resamples, seed 20260801 (AD-5)

## Pairing coverage

A pairing is rated only at 30 Matches and 15 seeds played from both sides; below either it is provisional (Story 7-1, AC3).

| Pairing | Matches | On side 0 | Mirrored seeds | Rated |
| --- | --- | --- | --- | --- |
| aggressive vs random | 200 | 100 / 100 | 100 | yes |
| aggressive vs spacing-aware | 200 | 100 / 100 | 100 | yes |
| random vs spacing-aware | 200 | 100 / 100 | 100 | yes |
