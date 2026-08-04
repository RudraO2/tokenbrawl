# Story queue

Stories are executed in the order below. Each is self-contained: an agent with no other context should be able to pick one up, read the linked contracts, implement, and know when it is done.

## Universal rules

**Exit gate, identical for every story:** `npm test` green **AND** `bash scripts/audit-invariants.sh` exiting zero. A reviewer saying "looks good" is not a gate.

**Frozen contracts.** Everything in `docs/contracts/` is frozen. A story that appears to require changing one must **stop and escalate**, never widen the interface — every parallel agent is building against it.

**Review discipline.** Each story is reviewed by an agent with no context of having written the code. An agent reviewing its own work rubber-stamps it. Maximum three fix-and-re-review cycles, then escalate.

**Commit after every green story.** Never leave the tree broken between stories.

## Order and dependencies

| Story | Epic | Depends on | Notes |
|---|---|---|---|
| 1.1 scaffold monorepo and CI gate | E1 | — | |
| 1.2 agent port, mock env, match runner | E1 | 1.1 | |
| 1.3 command log persistence | E1 | 1.2 | |
| **1.4 replay determinism gate** | E1 | 1.3 | **Blocks everything.** Do not weaken the test. |
| 1.5 token bank and reflex mode | E1 | 1.4 | |
| 1.6 parse failure handling | E1 | 1.5 | |
| 2.1 fighter state, deterministic step | E2 | 1.6 | |
| 2.2 five actions, commitment windows | E2 | 2.1 | |
| 2.3 graded baseline bots | E2 | 2.2 | |
| **2.4 skill separation gate** | E2 | 2.3 | **Blocks E3, E4, E5, E7.** Escalate on failure; never lower the thresholds. |
| 3.1 deployment agent, identical scaffold | E3 | 2.4 | |
| 3.2 groq adapter | E3 | 3.1 | **Needs human: `GROQ_API_KEY`** |
| 3.3 cerebras and google adapters | E3 | 3.2 | **Needs human: two more API keys** |
| 3.4 metering probe | E3 | 3.3 | |
| 3.5 provenance and prompt caching | E3 | 3.4 | |
| 4.1 canvas replay renderer | E4 | 2.4 | Parallel with E3 |
| 4.2 instant autoplay | E4 | 4.1 | |
| 4.3 hover reasoning | E4 | 4.2 | Centrepiece feature |
| 4.4 token bank HUD | E4 | 4.3 | |
| 4.5 timeline scrub | E4 | 4.4 | |
| 4.6 BYOK run your own fight | E4 | 4.5, 3.5 | |
| 4.7 BYOK model catalogue, custom models, Advanced endpoint | E4 | 4.6 | Fixes wrong committed limits. Read its INV-8 note **and** `docs/reports/byok-provider-limits.md` first. |
| 4.8 self-pacing, rate-limit-surviving BYOK runner | E4 | 4.6 | Paces from quota headers. Read its INV-1 note first. |
| 5.1 local CLI | E5 | 2.4 | Parallel with E3, E4 |
| 5.2 resumable tournament runner | E5 | 5.1 | |
| 5.3 scheduled CI tournament | E5 | 5.2 | **Needs human: Actions secrets** |
| 7.1 mirrored seeds and side swaps | E7 | 5.3 | |
| 7.2 ratings with confidence intervals | E7 | 7.1 | |
| 7.3 behavioural metrics | E7 | 7.2 | |
| 7.4 README, hero, honest claims | E7 | 7.3 | |
| 8.1 Command Log schema v2 | E8 | 1.3 | `(v2)` Pre-authorized contract change — the only story in E8/E9 allowed to touch `docs/contracts/` |
| 8.2 vertical axis and jump | E8 | 8.1, 2.2 | `(v2)` |
| 8.3 zoned strikes and matched block | E8 | 8.1, 2.2 | `(v2)` |
| 8.4 multi-hit strings and juggle state | E8 | 8.2, 8.3 | `(v2)` |
| **8.5 v2 skill-separation re-gate** | E8 | 8.2, 8.3, 8.4 | `(v2)` **Blocks E7's v2 ranking only** — does not block E9. Escalate on failure; never lower the thresholds. |
| 9.1 Extraction dev-reference and exclusion test | E9 | — | `(v2)` Goes first — no other E9 story touching sprites/audio lands before this |
| 9.2 Human-vs-Baseline-Bot arcade match | E9 | 2.4, 4.1, 9.1 | `(v2)` Does not depend on E8 |
| 9.3 AI-vs-AI Spectate and default stream | E9 | 4.2 | `(v2)` Does not depend on E8 |
| 9.4 Deployment visual identity | E9 | 3.1 | `(v2)` Does not depend on E8 |
| 9.5 frame-counted juice layer | E9 | 4.1, 9.1 | `(v2)` Highest translate-vs-reimplement risk — read the story's standing rule |
| 9.6 three-bus audio layer | E9 | 4.1, 9.1 | `(v2)` |
| 9.7 four-character custom roster | E9 | 9.1 | `(v2)` |
| 9.8 marketing landing page | E9 | 9.2, 9.3, 9.4, 7.2 | `(v2)` Capstone — exit gate includes a live UJ-5 walkthrough, not just engineering checks |

**E6 (MicroRTS) has no stories.** It is optional and deferred; revisit once E7 publishes its first tournament and the site is live.

**E8 and E9 are `(v2)` — additive to the shipped E1-E7 baseline, not a replacement.** E8 (2D engine) mirrors E2's role: invisible, gated, must clear its own skill-separation re-gate (8.5) before anything downstream ranks. E9 (arcade, visual identity, landing page, juice, audio, roster) mirrors E4's role: what a visitor actually sees. Unlike v1's pattern, E9 does **not** wait on E8's gate — Arcade Matches are excluded from rating by construction (`agentIdentity.kind: "human"`, architecture AD-14), and the rest of E9 is cosmetic. E9 does depend on E8's *code* existing before it's worth building against, per the epic-design roundtable's finding — see `_bmad-output/planning-artifacts/epics.md`.

## Where to stop and ask

- Story 1.4 or 2.4 failing. Both are gates. Deepening the work is the fix; weakening the test is not.
- Story 8.5 failing. Same gate, extended engine. Deepening the bot ladder (a 4th bot per `OQ-8`) or fixing 8.2-8.4's frame data is the fix; lowering the thresholds is not.
- Any E8/E9 story other than 8.1 that seems to need a `docs/contracts/` change. 8.1 is the one pre-authorized exception (PRD FR-33, architecture AD-13) — everything else routes back to it.
- Any E9 story that reads Extraction's source for anything beyond frame counts, timing curves, or trigger conditions. Behavioral facts are fair game; transliterated code is not — see 9.5's standing rule.
- Any story that seems to need a contract change.
- Any story that would let a **tournament** reach a non-free-tier endpoint. Story 4.7 opens a visitor-supplied endpoint for BYOK only, on the recorded reading that INV-8 governs *this project's* cost; tournament configuration stays locked to the free-tier allowlist and `assertFreeTierEndpoint` is not to be loosened.
- Any story that seems to need a server, database, worker, or WebSocket — that means the precompute design was misunderstood.
- Stories marked **needs human** — API keys and repository secrets cannot be self-served. Do not stub past them and mark the story done.
