# Skill separation gate

**Generated artefact — do not hand-edit.** `packages/env-fighter/src/skill-gate.test.ts`
recomputes this file from a fresh ladder run on every `npm test` and fails if it drifts.

Result: **PASS**

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `b2b38645b3263cabe9a127eb3e7e57f3718aaee524f7a332aa0129fa3956d344`
- Matches: 600 across 3 pairings (100 seeds x 2 side swaps each, AD-12)
- Distinct match ids: 600
- Confidence intervals: seeded percentile bootstrap, 2000 resamples, seed 987654321, 0.9500 coverage (AD-5)

## Pairings

| Stronger | Weaker | Matches | KOs | Win rate | 95% CI | Threshold | Met |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spacing-aware | random | 200 | 0 | 0.9950 | 0.9850 – 1.0000 | >= 0.6500 | yes |
| spacing-aware | aggressive | 200 | 200 | 0.8700 | 0.8200 – 0.9150 | >= 0.5500 | yes |
| aggressive | random | 200 | 78 | 0.8800 | 0.8350 – 0.9250 | >= 0.5000 | yes |

## Ladder

| Agent | Matches | Win rate | 95% CI |
| --- | --- | --- | --- |
| spacing-aware | 400 | 0.9325 | 0.9050 – 0.9550 |
| aggressive | 400 | 0.5050 | 0.4575 – 0.5537 |
| random | 400 | 0.0625 | 0.0412 – 0.0862 |

