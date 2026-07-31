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
| Martial Hero pack (`apps/web/public/sprites/martial-hero/`) | https://luizmelo.itch.io/martial-hero | **Creative Commons Zero (CC-0)** | 2026-08-01 |

This is the pack the brief and PRD named from the start. The licence was read
from the archive itself, not inferred from the store page — `LICENSE.txt` ships
alongside the art and says, verbatim:

> This pack - Martial Hero Asset Pack is Creative Commons Zero (CC-0). Can be
> used in commercial and non-commercial projects.

Nine sheets, 200×200 frames: Idle 8, Run 8, Attack1 6, Attack2 6, Death 6,
Take Hit 4, Fall 2, Jump 2. `layout.json` beside them maps the eleven clips in
`apps/web/src/render/animation.ts` onto those files.

The FightingICE / Rumble Fish 2 sprites remain **rejected**: Dimps grants use
"for research purposes" and no redistribution licence exists, which does not
survive a public repository.

### Swapping in a different pack

1. Drop the images in `apps/web/public/sprites/<pack>/`.
2. Write a `layout.json`: `frameWidth`, `frameHeight`, `scale`, `anchorY`, and
   one `{ image, x, y, frames }` per clip. Clip names are fixed by `CLIP_NAMES`.
3. Point `SPRITE_LAYOUT_URL` in `apps/web/src/boot.ts` at it.
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

