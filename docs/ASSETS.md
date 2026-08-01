# Asset provenance

Every asset that ships in this repo is recorded here **as it lands**, with its
source and its licence. Story 4.1's scope says why: reconstructing provenance
later is how licence problems become real ones.

The rule is absolute. An asset whose licence text has not been read does not
get committed — not with a "believed CC0" note, not temporarily. If a licence
cannot be verified, the story ships without the asset and says so.

## Fighter art

| Asset | Source | Licence | Checked |
|---|---|---|---|
| Martial Hero (`apps/web/public/sprites/martial-hero/`) — p1 | https://luizmelo.itch.io/martial-hero | **Creative Commons Zero (CC-0)** | 2026-08-01 |
| Martial Hero 2 (`apps/web/public/sprites/martial-hero-2/`) — p2 | https://luizmelo.itch.io/martial-hero-2 | **Creative Commons Zero (CC-0)** | 2026-08-01 |

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

