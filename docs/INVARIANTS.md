# Tokenbrawl Invariants

These are the product, not implementation detail. Violating any one makes the benchmark worthless regardless of how clean the code is.

**Every story is reviewed against this file.** A story that appears to require violating an invariant must stop and escalate — it must not quietly widen the constraint.

The gate is `scripts/audit-invariants.sh` exiting zero plus a green test suite. A reviewer saying "looks good" is not a gate.

---

## INV-1 — No wall-clock time may influence outcome

The Environment blocks until the Agent returns. Game time is denominated in Ticks and Decision Points, never seconds. A Deployment taking 40 seconds and one taking 200 milliseconds must have identical in-game effect.

**Machine check:** no `Date.now`, `performance.now`, `setTimeout`, `setInterval`, or `Math.random` in `packages/core` or `packages/env-*`. No timeout-driven default action anywhere in the match loop. Test: a mock Agent that sleeps 40 seconds and one that returns instantly produce identical Command Logs from the same seed.

## INV-2 — Matches are deterministic and replayable

Replaying a Command Log reproduces the Final-State Hash bit-identically.

**Machine check:** 100 consecutive replays of a fixture log, zero hash mismatches, run both in-process and across separate processes — same-process-only testing hides global-state leakage. No floating-point literals or float-producing operators in simulation state. Every PRNG draw threads through state.

## INV-3 — Rendering is decoupled from decision-making

Nothing renders during a Match. Playback runs from the stored Command Log at constant framerate. A viewer must not be able to tell how long any Agent took to think.

**Machine check:** `packages/core` and `packages/env-*` import no canvas, DOM, or rendering API. The player reads no wall-clock or latency field, and the schema exposes none. Frame pacing is identical for a Match between two slow Deployments and one between two fast ones.

## INV-4 — Thinking budget is metered, never set

Never send a reasoning-effort or thinking-level parameter. Let each Deployment think as much as it wants, and debit the Token Bank by the tokens actually consumed, reasoning tokens included. An empty bank forces Reflex Mode: `max_tokens=8`, bare Action only.

*Rationale: provider effort levels map to incomparable units across vendors and some give no token guarantees at all. Setting effort would replace the latency confound with a units confound — a different bug, not a fix.*

**Machine check:** no `reasoning`, `reasoning_effort`, `thinking`, or `thinkingLevel` key in any serialised request body, asserted by test against captured payloads. Bank after each call equals bank before minus reported completion tokens. First call after exhaustion has `max_tokens=8`.

## INV-5 — Every Deployment is probed before it is ranked

Some Deployments silently drop reasoning tokens when reasoning is combined with structured output; some never report usage at all. Detect both at startup. A Deployment that cannot be metered honestly is Reflex-Track only, and the exclusion appears in published results — never silently compared.

**Machine check:** the probe classifies at least one metering-capable and one non-reporting Deployment. No Deployment whose `meteringProbe` is anything but `reports-reasoning` appears in main-leaderboard output. The probe exercises reasoning *combined with* structured output, not the plain call alone.

## INV-6 — Provider and endpoint are logged per call

Free endpoints sometimes serve quantised weights. Tokenbrawl ranks Deployments, not platonic models, and the README says so.

**Machine check:** every `decisions[]` entry for a Deployment carries `provider` and `endpoint`. Two endpoints serving the same model name produce two distinct leaderboard rows. The README contains the ranking-deployments disclosure.

## INV-7 — Scaffolds are identical across all Deployments

Same system prompt, same Action grammar, same state serialisation. Per-Deployment prompt tuning is a confound, not a fix. A Deployment that needs different phrasing is a published caveat.

**Machine check:** the Scaffold string is byte-identical across all configured Deployments. No per-Deployment prompt override mechanism exists in the codebase.

## INV-8 — Zero recurring cost

No paid endpoint, no server, no database, no worker, at any tier, ever.

**Machine check:** every configured endpoint appears on the free-tier allowlist; a paid-tier endpoint fails configuration validation. No dependency on a hosted database, queue, or long-running process. CI runs on a public repository.

---

## Parse Failures are a first-class metric

Never retried. Retrying hands extra compute to whichever Deployment is worst at following the format, reintroducing the confound INV-1 exists to remove.

On failure: record it, apply the Fallback Action (`stand` — deliberately the least useful legal behaviour, so failure is never rewarded), continue. Parse-failure rate is reported alongside skill in every results table.

**Machine check:** exactly one Agent call per Decision Point per Agent. A Parse Failure never yields `block`, `special`, or a repeat of the previous Action.
