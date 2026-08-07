# The dev reference project

Every Epic 11 story translates something out of the reference arcade fighter
this game's look and feel are modelled on. This file says **where it is, what is
in it, and which parts may be copied verbatim** — so an agent picking up an E11
story cold does not have to guess, and does not have to be told again.

## Where it is

```
C:\Users\rpxi1\OneDrive\Documents\Desktop\Extraction
```

Referred to throughout the stories as `<REF>`. It is **outside this
repository** and is never checked in.

**Why this absolute path is allowed to be written here and nowhere else.**
`packages/cli/src/extraction-exclusion.test.ts` (Story 9.1 / AD-16) sweeps every
tracked file for out-of-root paths and for the project's name next to a path
separator. It exempts exactly two categories: `.md` files, because *"prose docs
legitimately name the mechanism"*, and its own source. So:

- **Markdown may name it.** This file, `docs/ASSETS.md` and the story files do.
- **No `.ts`, `.js`, `.json`, `.css`, `.html` or workflow file may**, ever.
- **Nothing under `apps/web/public/` may name it at all**, in a filename or in
  file contents, `.md` included. Copied *bytes* are fine — that is how the
  audio and sprites already got there — but the name must not travel with them.

If a story tempts you to type this path into source, the answer is that you are
copying an asset into `apps/web/public/` and recording its provenance in
`docs/ASSETS.md`, not reading across the boundary at runtime.

## Ownership — settled, do not re-open

The reference project and this repository **have the same owner**.
`docs/ASSETS.md`'s *"The 'author's own prior project' is the NextGen AI Arena
reference — same owner"* section states it, and Story 9.1's "must never ship"
acceptance criterion is a **build-portability rule about paths and names**, not
a licensing one. Do not raise provenance, IP or licensing as a blocker. If
`extraction-exclusion.test.ts` passes, there is nothing to escalate.

## Layout

| Path | What it is |
|---|---|
| `<REF>/game_source/js/` | **The source to read.** `core.js`, `screens.js`, `audio.js`, `vfx.js`, `atlas.js`, `stages.js`, `data.js`, `main.js` |
| `<REF>/game_local/js/` | A byte-identical copy of the same source. Either works; cite `game_source`. |
| `<REF>/game_assets/` | **The assets to copy from.** `atlas/`, `fx/`, `audio/`, `portraits/`, `sprites/`, `stages/`, `ui/` |
| `<REF>/game_local/assets/` | The same assets, byte-identical (checked by hash). |
| `<REF>/shots/` | Reference screenshots. `03_local_title.png`, `04_local_match.png` — the comparison targets for Story 10.1's visual gate. |
| `<REF>/ARCHITECTURE.md`, `HOW_TO_PLAY.md` | Prose overviews. |

## The map — where each thing lives

Cited by file and line so a story does not have to re-derive them.

| Subject | Location |
|---|---|
| Simulation freeze constant | `game_source/js/core.js:48` — `CINEMATIC_FREEZE = 90` |
| Freeze applied | `core.js:625`, `core.js:1387`; comment at `core.js:1441` |
| Ultimate cinematic drawing | `screens.js:2810` — `drawUltimateCinematic` |
| Cinematic timer, white flash at tick 80 | `screens.js:1494-1507` |
| Ultimate event → cues + cinematic start | `screens.js:1303-1314` |
| Beam | `screens.js:2108` — `drawBeam`; window at `screens.js:2213` |
| HUD helpers | `screens.js:2283` `hudParaPath`, `2291` `hudRoundRect`, `2302` `hudVGrad`, `2339` `hudFillPct` |
| Health bar + lag layer, colour tiers | `screens.js:2450-2458` |
| Super meter, 4 segments, gold pulse at 100 | `screens.js:2460-2472` |
| Audio graph and buses | `game_source/js/audio.js:55-90` |
| Cue table | `audio.js:7-25` |
| `sfx()` | `audio.js:169` · `voice()` `audio.js:204` · `vo()` `audio.js:232` · `duck()` `audio.js:256` |
| Hitstop / shake / flash | `game_source/js/vfx.js:232` — `feel` |
| Particle pool | `vfx.js:42-98` |

### Asset atlases

All three use a grid: `{ image, cell:{w,h}, grid:{cols,rows}, poses:{ name:{cells,fps,loop} } }`.
Cell `i` sits at `(i % cols * cell.w, floor(i / cols) * cell.h)`.

| Atlas | Image | Contents |
|---|---|---|
| `game_assets/atlas/fx.json` | `fx/fx_sheet.png`, 208×208, 5×5 | `spark_l` 0-3 @20 · `star` 4 · `spark_h` 5-8 @20 · `slash` 9 · `block` 10-12 @18 · `dust_puff` 13-14 · `dust` 15-18 @12 · `streak` 19 · `ko_burst` 20-24 @16 |
| `game_assets/atlas/fx_ult.json` | `fx/fx_ult.png`, 208×208, 5×5 | `ult_<id>_muzzle` / `_beam` / `_impact` per fighter |
| `game_assets/atlas/fx_blast.json` | `fx/fx_blast.png`, 208×208, 4×8 | `blast_<id>_head` / `_travel` / `_impact1` / `_impact2` |

**Every pose's cells are contiguous and stay inside one row**, so they map onto
this repo's existing strip format (`{ image, x, y, frames }` with a fixed
`frameWidth`) with no new atlas loader. Verified 2026-08-07.

Portraits: `game_assets/portraits/<id>.png` — eight exist; this project uses the
four in its roster.

## What may be copied verbatim, and what may never be

The owner's position is that this project should be a close copy of the
reference's look, feel and cinematics, minimally modified to fit four fighters
and the benchmark. **Art, colour, timing curves, layout and drawing technique
are all fair game to copy closely.** Same owner; there is no licensing question.

**Four mechanisms may never be copied, in any story, ever.** Each is load-bearing
for the benchmark's central claim — that a Match reproduces and that playback
cannot reveal how long a model took to think — and each already has a working
replacement here.

| Reference mechanism | Why it cannot come across | Use instead |
|---|---|---|
| `CINEMATIC_FREEZE = 90` inside `core.js`'s `step()` | Freezes the **simulation**. Moves Tick counts, Match length, the Decision Point budget and **every Final-State Hash in this repository**, invalidating every committed Command Log. | The renderer-held freeze on the clock axis (Story 10.4, `render/juice.ts`) |
| `Math.random()` in `vfx.js`'s particle pool | A replay claims a Match reproduces. An ungoverned RNG makes the same replay look different each viewing. | Scatter derived from `(filmIndex, agentIndex, ordinal, age)` (Story 9.5's `scramble`/`jitter`) |
| Wall clocks — `setTimeout`, `setInterval`, `performance.now()`, `Date.now()`, `AudioContext.currentTime` | INV-1 / INV-3. `source-discipline.test.ts` sweeps for every one of these by name. | Integer counts of clock frames, precomputed into a track (Stories 9.5, 9.6) |
| Stepped, mutable, module-level effect state (`let state`, `feelState`, `bufferCache`, `lastClatterTick`) | Cannot be scrubbed backwards, so Story 4.5's timeline shows the wrong thing. `source-discipline.test.ts` also bans module-level `let`/`var` outright. | A precomputed array indexed by frame; per-call state in a closure |

The shorthand: **copy the picture, never the plumbing.**

## Running the reference

`<REF>/PLAY.bat`, or serve `<REF>/game_local/` over a static server. Useful for
comparing feel directly; `<REF>/shots/` is usually enough for a visual gate.
