# Skill separation gate

**Generated artefact — do not hand-edit.** `packages/env-fighter/src/skill-gate.test.ts`
recomputes this file from a fresh ladder run on every `npm test` and fails if it drifts.

Result: **PASS**

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `1024a4dc9375cbc0710a1dcb4e4c15824fda350376e9e456ff5dd19932b3db9f`
- Matches: 600 across 3 pairings (100 seeds x 2 side swaps each, AD-12)
- Distinct match ids: 600
- Confidence intervals: seeded percentile bootstrap, 2000 resamples, seed 987654321, 0.9500 coverage (AD-5)

## Pairings

| Stronger | Weaker | Matches | KOs | Win rate | 95% CI | Threshold | Met |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spacing-aware | random | 200 | 0 | 1.0000 | 1.0000 – 1.0000 | >= 0.6500 | yes |
| spacing-aware | aggressive | 200 | 23 | 1.0000 | 1.0000 – 1.0000 | >= 0.5500 | yes |
| aggressive | random | 200 | 22 | 0.9550 | 0.9275 – 0.9800 | >= 0.5000 | yes |

## Ladder

| Agent | Matches | Win rate | 95% CI |
| --- | --- | --- | --- |
| spacing-aware | 400 | 1.0000 | 1.0000 – 1.0000 |
| aggressive | 400 | 0.4775 | 0.4287 – 0.5275 |
| random | 400 | 0.0225 | 0.0100 – 0.0375 |

