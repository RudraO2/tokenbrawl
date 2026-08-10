# Visual check runbook

The exit-gate step for any story that changes what the page looks like. Story
10.1 introduced it; `docs/stories/README.md` states it as a universal rule.

**A green `npm test` does not cover this.** The suite asserts canvas *call
sequences*. A wrong sprite scale, a missing backdrop and an unwired asset each
produce a perfectly valid call sequence, and all three shipped in Epic 9.

## Story 12.1: half of this is now a command

```bash
npm run visual-gate -- --label <story-key>
```

`scripts/visual-gate.mjs` boots the dev server, drives headless Chrome over the
DevTools Protocol with no dependencies, and writes six screenshots plus a
`report.json` to `docs/visual/<story-key>/`. It is the third entry in
`.bmad-loop/policy.toml`'s `[verify]` block, which means **it is a real exit
gate now, not a runbook step someone might skip.**

Everything this page said before Story 12.1 was true and was also ignored,
forty stories running. What changed is not the advice; it is that six of the
checks below fail a build instead of a reviewer's attention.

| Check | Fails when |
|---|---|
| `arcade-live-canvas` | `#arcade` has no visible canvas while a Match is being played |
| `no-horizontal-overflow` | the document scrolls sideways at 390×844 |
| `canvas-not-blank-*` | a visible canvas is under 2% ink — an unwired asset or a dead frame |
| `spectate-animates` | the Spectate canvas hash does not change over 700ms of playback |
| `console-clean` | any unallowlisted `error` or `warning` reaches the console |
| `surface-present-*` | `#app`, `#arcade` or `#spectate` is missing from the page |

### The waiver ratchet

`docs/visual/known-failures.json` names checks that fail *today* because a
later story owns the fix. A waived failure is reported and tolerated; an
unwaived one fails the build. The ratchet turns one way: **when a waived check
starts passing, the gate fails until its entry is deleted.** Removing your
story's waiver is part of your story. Adding a waiver to get a run green is
not a repair, and the entry's `story` and `clears_when` fields exist so that
the next reader can tell the difference.

### What the command still cannot do

It proves a frame was drawn. It cannot tell you the frame looks right — that
fighters read at the wrong scale, that the camera never moves, that a HUD label
sits on top of the bar it describes. **Open the PNGs.** They are written to
`docs/visual/<story-key>/` for exactly that, and they are gitignored because
their job is over when the story is.

## The three surfaces

Screenshot **all three, every time** — even when the story names only one. The
Spectate regression survived for exactly one reason: no story mentioned it, so
no story looked at it.

| Surface | Host element | What it is |
|---|---|---|
| Replay player | `#app` | the default autoplaying demo Match |
| Arcade | `#arcade` | Play-vs-CPU |
| Spectate | `#spectate` | the ambient AI-vs-AI stream |

## Steps

1. **Start the dev server.**

   ```bash
   cd apps/web && npm run dev
   ```

   It serves on `http://localhost:5173`.

2. **Load the page** and give the asset upgrades time to land. Sprites and the
   backdrop are deliberately *not* on the critical path (see `startup.ts`) — they
   swap into an already-running fight, so a screenshot taken immediately will
   correctly show the block artist and prove nothing. Wait ~2s after load.

3. **Scroll each surface into view and capture it.** Chrome DevTools MCP is the
   tool of record here: `new_page`, then `evaluate_script` to
   `document.querySelector('#app').scrollIntoView()`, then `take_screenshot`.
   Repeat for `#arcade` and `#spectate`.

4. **Check the console.** `list_console_messages` filtered to `error` and `warn`.
   The asset loaders in `startup.ts` warn rather than throw on failure — a pack
   that failed to decode reports itself here and nowhere else on screen, because
   the block-artist fallback looks deliberate.

5. **Compare against the reference.** The NextGen reference project's `shots/`
   directory holds the target: `03_local_title.png` (title / roster) and
   `04_local_match.png` (an arcade fight — HUD, fighter scale, stage).

6. **Record the finding in the story file.** A sentence per surface. "Screenshots
   taken" is not a finding; "fighters read at ~40% of frame height against the
   reference's ~30%, accepted for now" is.

## What to actually look at

Derived from the defects that got through, not from a general checklist:

- **Fighter scale.** Sprite drawn size is `frameHeight × scale`. Compare it to the
  canvas height. The roster packs crop tight — the character fills 158–175 of 208
  source pixels — so a scale copied from a loosely-cropped pack draws a fighter
  taller than the arena. Re-derive `scale` per pack from the character's own pixel
  height; never copy another pack's.
- **Feet on the floor.** Driven by `anchorY`. A fighter hovering or sunk through
  the ground means the anchor is wrong for that pack.
- **Is the art actually there?** A backdrop and two distinct sprites, not
  rectangles. A surface drawing blocks is a surface nobody wired.
- **Are both fighters distinct?** `drawFrame` falls back from a missing artist
  index to index 0, so a half-filled artists array silently dresses both fighters
  in the same pack.
- **HUD legibility** at the size it actually renders, not zoomed in.
- **Does the story's own feature appear?** Obvious, and it is what Story 9.7
  missed — it shipped four packs and wired two.

## Failure mode to avoid

Do not screenshot only the surface the story names, and do not accept a green
suite in place of a capture. Both were true for all three Epic 9 defects.
