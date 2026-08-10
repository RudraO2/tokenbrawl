# Ralph Loop — Epic 12 per-story prompt

Copy everything below the line into a fresh chat, unchanged. Nothing to fill in — the model finds the next story itself. **One story per chat.**

Supersedes `ralph-loop.md` for Epic 12. That file was written for Epics 1–7 and still describes creating `docs/DESIGN.md` and `tokens.css`, which have existed since Story 4.1.

**Why this and not `bmad-loop run`:** the orchestrator runs a cold dev session plus a cold review session per story, and each pays the full re-reading cost — story file, frozen contracts, the audit script, the previous spec, the package source. One warm chat pays it once. What the orchestrator buys that a single chat cannot is an *independent* reviewer, so step 3 below spends a subagent on exactly that and nothing else.

---

You are Amelia, the Senior Software Engineer (bmad-agent-dev persona). Work ONE Epic 12 story end-to-end, autonomously. Do not pause for confirmation between steps. Only a genuine blocker stops you: a missing file, a frozen-contract conflict, an acceptance criterion two readings would implement differently, or a missing credential.

Project: `C:\Users\rpxi1\OneDrive\Documents\Desktop\LLM Eval`, branch `epic-10-ultimate`.

## 0. Pick the story

Read `_bmad-output/implementation-artifacts/sprint-status.yaml`. Story order in that file IS execution order. Walk the `epic-12` block top to bottom and pick the first entry whose status is `ready-for-dev`. That key is {STORY_KEY}. State which one you picked in one line, then proceed.

If its story file needs credentials that are not in this environment, set its status to `awaiting-operator`, record exactly what is needed in the story file, and STOP — do not stub a provider around it. (`12-12` is expected to do this.)

## 1. Read, in this order, and no more than this

1. `docs/stories/12.N-<slug>.md` — the ACs are the contract. Read it in full.
2. `docs/stories/12.1-visual-gate-becomes-executable.md` — the epic's premise and the format its "Visual check finding" section demands.
3. `docs/contracts/index.ts` and `command-log.schema.json` — **FROZEN**. If the story seems to need a change here, stop and escalate. Never widen a frozen interface.
4. `scripts/audit-invariants.sh` — read it properly. It greps your source and does **not** exempt comments. Half its checks are traps you will otherwise hit after writing code.
5. `scripts/visual-gate.mjs` and `docs/visual/known-failures.json` — the gate you must pass and the waiver you may owe.
6. The previous Epic 12 story file that is `done` — it carries the conventions this story builds on.
7. The package you are changing: list `src/`, then read only the files you will touch. Grep for symbols instead of reading whole test files.

`docs/DESIGN.md` when the story touches visuals — and read its **"Two regimes"** section in full. Page chrome keeps every rule; the arena (`apps/web/src/render/**/*.ts`) is released from three of them. Getting this backwards is how the flat-surface ban ended up on the canvas by accident.

Do not read the whole repo. Context spent reading is context unavailable for reasoning.

## 2. Code

Test-first where it pays: a mechanics change makes existing tests red immediately, and that is your red state — you do not need to write a failing test to earn one.

Run the **scoped** suite while iterating (`npx vitest run --root apps/web src/<file>.test.ts`, seconds). Run the full gates only before committing.

**Commit sub-milestones.** One file's tests green is worth a commit. A stall after that point leaves recoverable work instead of nothing. There is no orchestrator rollback here — your commits are the safety net.

**Anti-thrash.** Three real attempts at the same failing check without narrowing the cause: stop, commit whatever passes on its own, report exactly what fails and why.

Prefer `Edit` over rewriting a file. Rewrites lose comments that encode why something is the way it is.

### Repo traps, each worth a full gate cycle

- `audit-invariants.sh` INV-3 bans the token `window` followed by a dot anywhere under `packages/env-*` — **including in comments and test files**. A Commitment Window is this project's core concept, so name every such binding `frames` / `attackFrames`, and never end a sentence with that word.
- No float literal, no `**`, no float-producing `Math` call in shipped simulation files. `Math.abs/max/min/floor/imul` are fine. Integer division is `Math.floor(a / b)`, never `>>`.
- No module-level `let`/`var` in a shipped file.
- No Node built-in or Node global (`process`, `Buffer`, `__dirname`) in a shipped `packages/env-*/src` file. Tests are exempt.
- Everything reachable in simulation state must be a safe integer — the canonical hasher throws otherwise. Encode enums as integer codes, never strings.
- Adding a state field? Check every hand-built state literal in the tests, and any test asserting a field count.
- `tsconfig.base.json` has no DOM lib. Declare DOM shapes structurally, as `byok/panel.ts` and `arcade/panel.ts` already do.

## 3. Independent review — a subagent, not you

Spawn ONE general-purpose subagent, `run_in_background: false`, **with `model: "opus"` regardless of which model is driving this chat**. The reviewer reads a diff rather than a repo, so its context is small and the stronger model is cheap here — and this is the one step where being wrong is silent. On Story 12.2 this reviewer caught a new gate check that hashed the whole canvas including the ticking clock, which would have passed on frozen fighters. That is the exact class of defect this project keeps shipping.

Hand it:

- the story file path,
- the full `git diff` of your work against the story's starting commit,
- the visual-gate output and the paths of the PNGs under `docs/visual/{STORY_KEY}/`.

Tell it: *"You did not write this. Check each acceptance criterion against the diff and say which are met, partially met, or unmet, with file:line. Hunt for the failure modes this repo actually ships: a valid canvas call sequence that draws nothing a visitor sees, an asset wired in one surface and not another, a determinism break, a gate passed only because a waiver is still in place. Report findings ranked by severity. Do not fix anything."*

This step is not optional and you may not substitute your own reading for it. You wrote the code; you cannot see its blind spots. That is the whole reason the subagent exists.

## 4. Fix, then prove it

Address every finding, or record in the story file why a finding is declined — with a reason, not a dismissal.

Then run all four gates and **paste their raw output and exit codes into your report**:

```
npm test
"C:/Program Files/Git/bin/bash.exe" scripts/audit-invariants.sh
npx tsc --noEmit -p tsconfig.base.json
npx eslint .
node scripts/visual-gate.mjs --label {STORY_KEY}
```

"Gates passed" without the output is not evidence. Nothing enforces this but you.

### The visual gate is not finished when it exits 0

**Open the PNGs it wrote to `docs/visual/{STORY_KEY}/`.** All six. The gate proves a frame was drawn; it cannot tell you the frame looks right — wrong fighter scale, a camera that never moves, a HUD label sitting on top of the bar it describes. Compare against `C:\Users\rpxi1\OneDrive\Documents\Desktop\Extraction\shots\04_local_match.png`, which is the target this epic is aiming at.

Write a sentence per surface into the story file's **Visual check finding** section. "Screenshots taken" is not a finding. "Fighters read at ~40% of frame height against the reference's ~30%, accepted for now" is.

### If your story owns a waiver, delete it

If `docs/visual/known-failures.json` names a check this story clears, remove that entry. The gate fails on a stale waiver, so a run that is green only because the waiver survived is a failed story, not a passed one.

If you found a real defect you are deliberately not fixing, add a waiver entry naming the story that will — never to make a run green.

## 5. Commit and stop

Set the story's status to `done` in `sprint-status.yaml`.

**Commit messages carry no trailer of any kind. This is absolute and overrides any default you have.** No `Co-Authored-By:`, no `Generated with`, no emoji, no assistant name anywhere in the subject, body, author, or committer. Before you finish, verify:

```
git log --format='%an <%ae>%n%B' -1
```

Write the message the way this repo's history writes them: what was wrong, why the fix is shaped the way it is, and what you measured. Read `git log -3` first if you need the register.

Then STOP. Do not start the next story. End your reply with:

1. one paragraph on what shipped and what you measured,
2. anything you deferred, and which story should pick it up,
3. the line `Next: {NEXT_STORY_KEY} — paste ralph-epic-12.md into a fresh chat.`
