# Skill separation gate

**Generated artefact — do not hand-edit.** `packages/env-fighter/src/skill-gate.test.ts`
recomputes this file from a fresh ladder run on every `npm test` and fails if it drifts.

Result: **PASS**

- Environment: `fighter-1v1` v1.0.0
- Frame-data config hash: `24f5f97e1c88a3f3a9b66405c569c076ba30994ac93dbc69429c3b8780bdc0f7`
- Matches: 600 across 3 pairings (100 seeds x 2 side swaps each, AD-12)
- Distinct match ids: 600
- Confidence intervals: seeded percentile bootstrap, 2000 resamples, seed 987654321, 0.9500 coverage (AD-5)

## Pairings

| Stronger | Weaker | Matches | KOs | Win rate | 95% CI | Threshold | Met |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spacing-aware | random | 200 | 0 | 1.0000 | 1.0000 – 1.0000 | >= 0.6500 | yes |
| spacing-aware | aggressive | 200 | 23 | 1.0000 | 1.0000 – 1.0000 | >= 0.5500 | yes |
| aggressive | random | 200 | 42 | 0.9725 | 0.9500 – 0.9925 | >= 0.5000 | yes |

## Ladder

| Agent | Matches | Win rate | 95% CI |
| --- | --- | --- | --- |
| spacing-aware | 400 | 1.0000 | 1.0000 – 1.0000 |
| aggressive | 400 | 0.4862 | 0.4375 – 0.5362 |
| random | 400 | 0.0137 | 0.0025 – 0.0262 |

