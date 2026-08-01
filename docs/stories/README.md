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

**E6 (MicroRTS) has no stories.** It is optional and deferred; revisit once E7 publishes its first tournament and the site is live.

## Where to stop and ask

- Story 1.4 or 2.4 failing. Both are gates. Deepening the work is the fix; weakening the test is not.
- Any story that seems to need a contract change.
- Any story that would let a **tournament** reach a non-free-tier endpoint. Story 4.7 opens a visitor-supplied endpoint for BYOK only, on the recorded reading that INV-8 governs *this project's* cost; tournament configuration stays locked to the free-tier allowlist and `assertFreeTierEndpoint` is not to be loosened.
- Any story that seems to need a server, database, worker, or WebSocket — that means the precompute design was misunderstood.
- Stories marked **needs human** — API keys and repository secrets cannot be self-served. Do not stub past them and mark the story done.
