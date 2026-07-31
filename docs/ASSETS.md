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
| Procedural block artist (`apps/web/src/render/artist.ts`) | Authored in this repo | Same licence as this repository | 2026-08-01 |

The fighters are drawn from code rather than from a sprite sheet. This is a
deliberate choice, not an oversight:

- The story requires **CC0 assets only**, and explicitly rejects the
  FightingICE / Rumble Fish 2 sprites — Dimps grants use for research purposes
  and there is no redistribution licence.
- The intended CC0 source (the Martial Hero family on itch.io) could not be
  downloaded and its licence file could not be read in the session that built
  this story. Committing art on the *assumption* it is CC0 is exactly the
  failure this file exists to prevent.

`FighterArtist` in `apps/web/src/render/artist.ts` is the seam a sheet-backed
artist drops into. Swapping it changes no other file. See
`_bmad-output/implementation-artifacts/deferred-work.md`.

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
