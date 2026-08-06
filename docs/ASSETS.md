# Asset provenance

Every asset that ships in this repo is recorded here **as it lands**, with its
source and its licence. Story 4.1's scope says why: reconstructing provenance
later is how licence problems become real ones.

The rule is absolute. An asset whose licence text has not been read does not
get committed — not with a "believed CC0" note, not temporarily. If a licence
cannot be verified, the story ships without the asset and says so.

## The "author's own prior project" is the NextGen AI Arena reference — same owner

Wherever a row below reads *"the author's own prior project"*, that project is
**Extraction / NextGen AI Arena**, the reference arcade fighter this game's look
and feel is modelled on. Both it and this repository have the same owner, so
those assets are the author's own IP and ship deliberately.

This is settled. Do not re-open it as a licensing, IP or provenance question, and
do not read Story 9.1's "the reference must never ship" acceptance criteria as
contradicting it — that story governs *absolute filesystem paths and the literal
project name in tracked non-Markdown files*, a build-portability rule, and it is
enforced mechanically by `packages/cli/src/extraction-exclusion.test.ts`. If that
test passes, there is nothing to escalate.

## Fighter art

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Clawde (`apps/web/public/sprites/clawde/`) | authored in this repo — cropped/re-assembled from the author's own prior project's spritesheet (`clawde_f0_sheet.png`, own IP) into this project's per-clip strip format | **Author-owned, used with permission** | 2026-08-06 |
| Chatty (`apps/web/public/sprites/chatty/`) | authored in this repo — cropped/re-assembled from the author's own prior project's spritesheet (`chatty_f0_sheet.png`, own IP) into this project's per-clip strip format | **Author-owned, used with permission** | 2026-08-06 |
| Gemini (`apps/web/public/sprites/gemini/`) | authored in this repo — cropped/re-assembled from the author's own prior project's spritesheet (`gemini_f0_sheet.png`, own IP) into this project's per-clip strip format | **Author-owned, used with permission** | 2026-08-06 |
| Grokk (`apps/web/public/sprites/grokk/`) | authored in this repo — cropped/re-assembled from the author's own prior project's spritesheet (`grokk_f0_sheet.png`, own IP) into this project's per-clip strip format | **Author-owned, used with permission** | 2026-08-06 |

Story 9.7's four-character roster. The source spritesheets are frames from the
author's own prior fighting-game project (also owned by the author), each a
5×5 grid of 208×208 poses. `idle`/`walk` repeat their 2 real frames (A,B,A,B)
to satisfy this project's 4-frame minimum; `attack-*`/`special-*` phases
borrow adjacent single-pose frames (punch/kick/charge) duplicated to satisfy
each phase's minimum — an interim mapping this story exists to make honest,
not a claim the source had eleven distinct combat phases. `LICENSE.txt` ships
beside each pack. Only two packs load into a live Match at a time
(`apps/web/src/startup.ts`'s `SPRITE_LAYOUT_URLS`, currently `clawde` +
`chatty`); `gemini` and `grokk` ship ready for a future character-select story.

**Superseded, not deleted:**

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Martial Hero (`apps/web/public/sprites/martial-hero/`) — p1 | https://luizmelo.itch.io/martial-hero | **Creative Commons Zero (CC-0)** | 2026-08-01 |
| Martial Hero 2 (`apps/web/public/sprites/martial-hero-2/`) — p2 | https://luizmelo.itch.io/martial-hero-2 | **Creative Commons Zero (CC-0)** | 2026-08-01 |

Kept as historical provenance record per this doc's own rule — reconstructing
provenance later is how licence problems become real ones. No longer wired
into `SPRITE_LAYOUT_URLS` as of 2026-08-06 (Story 9.7); the pack directories
and their `layout.json`/`LICENSE.txt` stay on disk.

This is the pack the brief and PRD named from the start. The licence was read
from the archive itself, not inferred from the store page — `LICENSE.txt` ships
alongside the art and says, verbatim:

> This pack - Martial Hero Asset Pack is Creative Commons Zero (CC-0). Can be
> used in commercial and non-commercial projects.

Two packs, one per fighter, so a viewer tells them apart by silhouette rather
than by reading a health bar. Both licences were read from their own archives
and both `LICENSE.txt` files ship beside the art; a test asserts they stay
there.

Their frame counts differ, which is the point of the layout format:

| | Idle | Run | Attack1 | Attack2 | Death | Take Hit |
|---|---|---|---|---|---|---|
| Martial Hero (p1) | 8 | 8 | 6 | 6 | 6 | 4 |
| Martial Hero 2 (p2) | 4 | 8 | 4 | 4 | 7 | 3 |

`layout.json` beside each maps the eleven clips in
`apps/web/src/render/animation.ts` onto those files. With only four attack
frames, pack 2's Commitment Window phases overlap (startup 0-1, active 1-2,
recovery 2-3) — each phase still *begins* on a different frame, which is the
property a test enforces for both packs and the one a viewer needs.

`anchorY` differs between the packs (120 vs 129) because the artist drew the
characters at different heights inside the same 200×200 frame. Both were found
by looking at the rendered page, not by reading the files.

The FightingICE / Rumble Fish 2 sprites remain **rejected**: Dimps grants use
"for research purposes" and no redistribution licence exists, which does not
survive a public repository.

### Arena backdrop

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Mountain Dusk (`apps/web/public/sprites/mountain-dusk/`) | https://ansimuz.itch.io/mountain-dusk-parallax-background | **CC0 1.0 Universal** | 2026-08-01 |

Verified twice: the pack's bundled `public-license.pdf` contains "Creative
Commons Zero (CC0", and the itch.io page states "Creative Commons Zero v1.0
Universal". The PDF lives at `docs/licences/mountain-dusk-public-license.pdf`,
not in `public/` — it is 816 KB, `public/` ships verbatim, and the licence
would otherwise outweigh every sprite in the app four times over.

Six layers drawn back to front, static rather than parallaxed — the arena is a
single fixed axis with no camera, so a scroll would be motion corresponding to
nothing in the simulation. Anchored to the bottom so the treeline sits behind
the fighters and the sky crops off.

`dim: 0.55` fades the stack toward `--tb-bg`. Full strength fought the fighters
for attention and dropped the bone-white sprites' contrast below the point
where the action reads; scenery that competes with the subject is a defect.

**Rejected:** `edermunizz/free-pixel-art-forest` — CC-BY-**ND**, no derivatives,
which does not survive being recomposited into a stage.

### Swapping in a different pack

1. Drop the images in `apps/web/public/sprites/<pack>/`.
2. Write a `layout.json`: `frameWidth`, `frameHeight`, `scale`, `anchorY`, and
   one `{ image, x, y, frames }` per clip. Clip names are fixed by `CLIP_NAMES`.
3. Point `SPRITE_LAYOUT_URLS` in `apps/web/src/startup.ts` at it. One entry per
   agent index; the packs are swapped into an already-running fight as they
   decode, so a pack that fails to load costs nothing but its own silhouette.
4. Record its source, licence, and the date you read the licence above.

No rendering code changes. `validateSpriteSheetLayout` rejects a layout that is
missing a clip, promises fewer frames than the animation needs, points off
origin, or over-runs its own image.

`anchorY` is where the character's feet sit inside a frame. Packs pad their
frames generously and never agree on how much; get it wrong and the fighter
floats above the floor or sinks through it.

## Audio

Story 9.7 lands the five cues `apps/web/src/render/audio.ts`'s
`DEFAULT_AUDIO_TUNING` named at the time — the bus wiring itself shipped silent
in Story 9.6. Story 10.5 adds the sixth, `sfx_special`, for the Ultimate.

| Asset | Source | Licence | Checked |
|---|---|---|---|
| `apps/web/public/audio/music_battle.mp3` | authored in this repo — the author's own prior project's music bed (own IP) | **Author-owned, used with permission** | 2026-08-06 |
| `apps/web/public/audio/sfx_hit_l.mp3` | authored in this repo — the author's own prior project's SFX (own IP) | **Author-owned, used with permission** | 2026-08-06 |
| `apps/web/public/audio/sfx_hit_h.mp3` | authored in this repo — the author's own prior project's SFX (own IP) | **Author-owned, used with permission** | 2026-08-06 |
| `apps/web/public/audio/sfx_ko.mp3` | authored in this repo — the author's own prior project's SFX (own IP) | **Author-owned, used with permission** | 2026-08-06 |
| `apps/web/public/audio/vo_ko.mp3` | authored in this repo — the author's own prior project's voice line (own IP) | **Author-owned, used with permission** | 2026-08-06 |
| `apps/web/public/audio/sfx_special.mp3` | authored in this repo — the author's own prior project's Ultimate SFX (own IP), copied byte-for-byte from its `audio/sfx_special.mp3` | **Author-owned, used with permission** | 2026-08-07 |

`sfx_special.mp3` is a genuinely different sample from `sfx_hit_h.mp3`, not a
re-encode or a louder copy — the two files' MD5s differ
(`9bbc6a26…` against `c93bae72…`), and Story 10.5's whole point is that an
Ultimate which sounds like a heavy hit teaches a listener nothing. It comes
from the same source project and the same owner as the five cues above, and
ships on the same basis.

`DEFAULT_AUDIO_TUNING` is global, not per-fighter: one hit SFX pair, one KO SFX,
one KO voice line, one Ultimate SFX regardless of which two packs are loaded.
The source project ships per-character variants (`sfx_clawde_hit_l.mp3`,
`vo_chatty_ko.mp3`, `sfx_<id>_ult.mp3`, …);
only its generic, character-neutral files are used here, matching the cue
names this codebase already calls by. A later story that makes audio
per-fighter would draw from the same source and add rows here the same way.

Between Story 9.6 and Story 9.7 the shipped player ran the whole audio graph
and played nothing, and that was not an oversight being deferred — it was the
fail-soft path the story requires, exercised on every page load rather than
only in a test: every cue 404s, each missing name is warned about once, cached
as absent, and never fetched again, and the Match keeps playing silently.
Exactly the shape `loadArtist` and `loadBackdrop` already use for a sprite pack
that will not decode. That path is still what a name with no file behind it
takes, and it is still what the whole layer degrades to on a browser with no
WebAudio or a context no gesture ever unlocked.

### Bus layout

Three independent WebAudio `GainNode`s, each connected straight to
`destination`, so moving one leaves the other two untouched:

| Bus | What goes on it | Base level | Ducked to |
|---|---|---|---|
| `music` | one looping bed, started at clock frame 0 | 0.80 | 0.25 under a voice line |
| `sfx` | one-shot per hit, heavy hit, KO and Ultimate | 1.00 | — |
| `voice` | one-shot per KO | 1.00 | — |

Levels are tuned as integer basis points in
`apps/web/src/render/audio.ts`'s `DEFAULT_AUDIO_TUNING`; the single division
into a float happens at the `GainNode` boundary in `audio-bus.ts`. Every
duration in the mix — the duck window, the per-fighter voice rate limit — is an
integer count of *clock* frames, never milliseconds, so the sound of a Match is
identical on a 60Hz laptop, a 144Hz monitor and a backgrounded tab (INV-1,
INV-3).

### Cue name → filename

A cue carries a name, not a URL. `audio-bus.ts` resolves it to
`apps/web/public/audio/<name>.mp3`, served from this origin — no CDN, for the
same reason the typefaces are self-hosted: the site must render identically
offline and in CI.

The names the shipped tuning asks for:

| Cue | Bus | File |
|---|---|---|
| `music_battle` | music | `public/audio/music_battle.mp3` |
| `sfx_hit_l` | sfx | `public/audio/sfx_hit_l.mp3` |
| `sfx_hit_h` | sfx | `public/audio/sfx_hit_h.mp3` |
| `sfx_ko` | sfx | `public/audio/sfx_ko.mp3` |
| `vo_ko` | voice | `public/audio/vo_ko.mp3` |
| `sfx_special` | sfx | `public/audio/sfx_special.mp3` |

`sfx_special` is the only cue that is not keyed on a `JuiceKind`. It fires on
`CinematicEvent.filmIndex` — the film frame Story 10.4's Ultimate freeze opens
on — so the sound and the picture are driven off one index and cannot drift
apart when a visitor scrubs the timeline across it.

Adding a sound is dropping a file at its path and recording it in the table
above with its source, licence and the date the licence was read. Nothing in
`apps/web/src` changes; a name with no file behind it is silent, and a file with
no name asking for it is never fetched. `docs-discipline.test.ts` sweeps
`public/audio/` against the provenance table above, so a file dropped in
without a row fails the suite.

Audio can be auditioned before Story 9.7 lands without committing anything:
`apps/web/src/dev/local-sprites.ts` already serves `.mp3`/`.wav`/`.ogg` from the
gitignored dev-reference config, which is a Vite dev-server plugin and is
structurally absent from `vite build`'s output.

## Command Logs

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Spectate manifest Command Logs (`apps/web/public/replays/spectate-01.command-log.json` … `spectate-06.command-log.json`) | Generated in this repo (Story 9.3), local CLI | **Authored in this repo — no third-party rights** | 2026-08-05 |
| Spectate manifest (`apps/web/public/replays/manifest.json`) | Generated in this repo (Story 9.3), local CLI | **Authored in this repo — no third-party rights** | 2026-08-05 |

Six deterministic Baseline-Bot-vs-Baseline-Bot Matches, generated locally with
no provider key and no network by `apps/web/scripts/build-spectate-
manifest.mts` — the same `runMatch`/`buildCommandLog` composition
`packages/cli/src/run.ts` uses for a tournament, run here as a one-off script
rather than through a config file (AD-17: the default stream is a manifest
walk over already-committed logs, never a computation triggered by a
visitor). Regenerate with:

```
node --experimental-strip-types --no-warnings \
     --import ./packages/cli/bin/register.mjs apps/web/scripts/build-spectate-manifest.mts
```

Every pairing crosses each of the three graded Baseline Bots (`aggressive`,
`spacing`, `random`) against a different one, over six distinct seeds, so the
loop reads as six different fights rather than one Match repeating:

| Entry | Seed | Pairing |
|---|---|---|
| `spectate-01` | 9301 | aggressive vs spacing |
| `spectate-02` | 9302 | spacing vs aggressive |
| `spectate-03` | 9303 | random vs aggressive |
| `spectate-04` | 9304 | aggressive vs random |
| `spectate-05` | 9305 | spacing vs random |
| `spectate-06` | 9306 | random vs spacing |

`manifest.json` carries a fixed `loopStartEpochMs` anchor (a constant, not a
timestamp taken at generation time) and each entry's `frameCount`, which
together let `apps/web/src/spectate/manifest.ts`'s `offsetForNow` compute
where a visitor arriving right now would join the loop, without ever
recomputing a Command Log on demand.

## Typefaces

Both faces are self-hosted as `woff2` under `apps/web/public/fonts/`. No CDN:
the site is static and must render identically offline and in CI, and a
third-party host is a dependency someone else can withdraw.

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Bricolage Grotesque (variable, 200–800) | Google Fonts, upstream https://github.com/ateliertriay/bricolage | **SIL Open Font License 1.1** — full text in `bricolage-grotesque.OFL.txt` | 2026-08-01 |
| Departure Mono 1.500 | https://departuremono.com | **SIL OFL** — see the provenance note below | 2026-08-01 |

Bricolage's licence was read from the project's own `OFL.txt`, which is
committed beside the font.

### The hero's pixel font

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Tokenbrawl 5x7 hero font (`apps/web/src/hero/font.ts`) | Authored in this repo (Story 7.4) | **Repository licence** — no third-party rights | 2026-08-02 |

The README hero is a GIF rasterised by this project, and a raster needs glyphs
as pixels. Turning a `woff2` into pixels needs a font engine, which is a
dependency `apps/web` may not take (INV-8, and its two-devDependency budget), so
the 5x7 glyph table was written here — the same choice `createBlockArtist` made
about fighter art, and for the same reason: an asset authored in the repository
has no licence to verify.

It is uppercase-only, it is not Departure Mono, and it is not a substitute for
it: the page still loads the real face, and this table exists only so the hero
can be rendered without a browser.

**Departure Mono is held to a weaker standard, and the difference is
recorded rather than smoothed over.** The distributed file ships no `OFL.txt`
and embeds no licence string in its name table. The licence claim comes from
the author's own site, which states: *"Departure Mono is a monospaced pixel
font by Helena Zhang, licensed under the SIL OFL."* The copyright line
(`2024 Helena Zhang`) was read out of the font binary. That is a first-party
statement, but it is not the archive-shipped licence text that Martial Hero and
Bricolage both have. `departure-mono.LICENSE.txt` says so in full. If this
project ever needs a stricter paper trail, get the OFL text from the author
directly.

