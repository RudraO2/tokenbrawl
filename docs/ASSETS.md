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
| Bricolage Grotesque | https://github.com/ateliertriay/bricolage | SIL Open Font License 1.1 — **verify before committing the binary** | pending |
| Departure Mono | https://departuremono.com | SIL Open Font License 1.1 — **verify before committing the binary** | pending |

**The font binaries are not committed yet.** `app.css` declares both
`@font-face` rules and `tokens.css` names both families, so the moment the two
`woff2` files are dropped into `apps/web/public/fonts/` the site picks them up
with no code change. Until then the fallbacks (`Arial Black` and the platform
monospace) render, which is why the stacks in `tokens.css` are chosen rather
than incidental.

Whoever adds the binaries must fill in the **Checked** column with the date the
`OFL.txt` in the downloaded archive was actually read, and change the licence
cell to remove the warning. Both are believed to be OFL 1.1 from their public
pages; believed is not checked.
