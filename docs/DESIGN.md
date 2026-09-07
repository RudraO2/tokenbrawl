# Tokenbrawl visual design

The style is a **neon arcade cabinet**: a navy-black ground, glass panels with a
hairline edge, one electric cyan that carries "live", gold reserved for the
Ultimate and the win, and light that is allowed to glow. It replaced the
neubrutalist page of Stories 4.1–12.12 on 2026-09-07, when the product grew a
real arcade cabinet (`/play`) and the flat, hard-shadowed chrome around it read
as a spreadsheet wrapped around a fighting game.

Everything below is enforced by `apps/web/src/style-discipline.test.ts` where
it can be. The rest is a matter of taste, and taste is decided here once.

## Tokens

`apps/web/src/styles/tokens.css` is where the **page** declares colour. A hex
literal written anywhere else in page chrome is a defect. Translucent colours
(`rgba(...)`) follow the same rule: every glow, tint and scrim is declared once
in `tokens.css` and used by name, so a raw `rgba(` at a call site fails the
sweep exactly as a raw hex does.

Exactly two other files may hold a colour literal, both named in
`apps/web/src/style-discipline.test.ts` rather than pattern-matched:

- `apps/web/src/render/theme.ts` — the canvas mirror of five tokens (`bg`,
  `ink`, `accent`, `warn`, `muted`). A canvas cannot cheaply read a CSS custom
  property, so the values are copied, and the same test asserts every copy still
  appears in `tokens.css`.
- `apps/web/src/render/arena-palette.ts` — the **arena's** colours, which are
  not brand tokens at all. See "Two regimes" below.

One hex lives outside all three, and deliberately: `apps/web/index.html`
declares the ground colour inline so the first paint is already dark. The suite
pins it to `--tb-bg` and allows no second one.

| Token | Value | Role |
|---|---|---|
| `--tb-bg` | `#07080f` | the ground |
| `--tb-bg-2` / `--tb-bg-3` | `#0e1020` / `#161a30` | panels; raised controls |
| `--tb-line` / `--tb-line-2` | `#262b45` / `#3a4270` | hairlines; a hovered edge |
| `--tb-ink` / `--tb-ink-2` / `--tb-muted` | `#eef2ff` / `#aab3d6` / `#7d86ad` | headings and body; secondary copy; metadata |
| `--tb-accent` | `#16c7e4` | live, active, selected, focused — the cabinet's neon |
| `--tb-gold` | `#ffd24a` | the Ultimate, the winner, the coin slot |
| `--tb-magenta` / `--tb-violet` | `#ff3fa4` / `#7c5cff` | the second fighter's glow; depth behind the neon |
| `--tb-warn` | `#ff4d5a` | Reflex Track, exclusions, parse failures, a hash that did not verify |
| `--tb-ok` | `#38e27a` | verified, done |
| `--tb-fighter-*` | one per cabinet fighter | a card's glow, never body colour |

Glows and tints (`--tb-glow-*`, `--tb-tint-*`, `--tb-scrim`, `--tb-scanline`)
are the only translucent values on the page, and they are derived from the
colours above.

**Contrast.** Against `--tb-bg`: ink 18.9:1, ink-2 9.7:1, muted 4.9:1, accent
10.4:1, gold 13.0:1. Warning *text* is set in `--tb-warn` on `--tb-tint-warn`
(a warn-coloured tint over the panel), which measures 5.6:1 and reads as a
warning rather than as body copy.

## Type

- **Display** — Bricolage Grotesque, weight 800, uppercase, `-0.02em`
  tracking, for headings and buttons.
- **Data** — Departure Mono for every number a visitor reads as data and for
  every label, eyebrow and nav link: token counts, ticks, ratings, hashes,
  model ids, the control legend. Pixel-grid mono against pixel-art fighters is
  the whole point.
- **Body** — Bricolage Grotesque at normal weight. There is no third family,
  on the page or on the canvas: the canvas font shorthands in `theme.ts` are
  checked against `tokens.css` by the same test.

Both are self-hosted `woff2` under `apps/web/public/fonts/`. No CDN, no
`@import` from a third-party host: the site is static and must render
identically offline and in CI.

## The rules

- **Corners** come from three radii and a circle: `--tb-radius` (14px) for
  panels and cards, `--tb-radius-sm` (8px) for inputs and small blocks,
  `--tb-radius-pill` for buttons, chips and segmented controls, `50%` for a
  dot. A fourth number is a fourth opinion.
- **Edges** are one hairline (`--tb-border-width`, 1px) in `--tb-line`. A
  hovered or selected card brightens its edge and glows; it does not thicken.
- **Glow** is allowed and is the house effect, but every `box-shadow` colour
  is a token (`0 0 18px var(--tb-glow-accent)`). Depth is one drop shadow,
  `--tb-shadow-drop`, on cards.
- **Gradients** are allowed for surfaces and for the two primary buttons. Text
  is always solid ink.
- **Focus** a visible 3px `--tb-accent` outline with a real offset, on every
  interactive element. Never `outline: none`.
- **Motion** every transition is `var(--tb-step)` long with `var(--tb-ease)`;
  entrances use `var(--tb-enter)`. Three ambient animations exist (the coin
  blink, the fighters' idle bob, the live dot) and `prefers-reduced-motion:
  reduce` zeroes both durations and stops all three. Nothing here may vary per
  Match: playback duration that depended on how long a Deployment took to think
  would leak exactly what INV-3 forbids.
- **Layout** one column, `--tb-page-max` (1280px) wide, generous vertical
  rhythm, one screen at a time behind a sticky top bar. Every canvas box
  scales to its container (`width: 100%; height: auto`) and never sets the
  document wider than the viewport.
- **No CSS framework, no runtime dependency.** `apps/web` has `vite` and
  `vitest` and nothing else.

## Two regimes: the page and the arena

**The ruling, 2026-08-07, still stands.** The page's rules were written for the
UI and never for the game drawn inside it. The canvas that draws a Match is
the arena, and a fighting game's impact reads through light, and light is
alpha.

**Where the boundary runs.** Every non-test **`.ts`** file under
**`apps/web/src/render/`** is the arena. Everything else in `apps/web/src` is
the page. `apps/web/src/style-discipline.test.ts` holds the boundary as one
named constant, `ARENA_BOUNDARY`, and pins the arena's exact membership in
one assertion, so a file joining it is a reviewable act rather than a side
effect of where it was put.

**`.ts` and not `.css`.** A stylesheet cannot draw on a canvas, so a
`render/hud.css` would be page chrome wearing the arena's directory name.
There is none today and the boundary will not release one.

**`render/theme.ts` is inside the directory and is not released.** It holds
the five brand colours as the canvas mirror of `tokens.css`, and brand is page.

**`hero/` stays on the page side.** It drives a canvas too, but what it
produces is a landing-page asset. `cabinet/`, `spectate/`, `landing/`,
`byok/` and `shell/` are page: they are DOM panels that *host* a surface.

**The arena is released from the colour-and-compositing rules** — it may mix
its own `rgba(`, set `globalAlpha`, set a blend mode — and from nothing else.
Every hex it uses still lives in `render/arena-palette.ts`, which declares the
reference's gold, its health tiers, its super meter and one aura per fighter,
each value once, as a lowercase `#rrggbb`. The 4.5:1 text floor does not
govern that palette; WCAG 1.4.11's 3:1 floor for graphical objects does, and
the module records the one value it changed.

**The arena's geometry is its own.** `--tb-arena-border-width` (4px) and
`--tb-arena-shadow-offset` (6px) are the canvas HUD's chunky frame, mirrored
into `theme.ts` and checked against `tokens.css`. They are not the page's
hairline, and the page does not borrow them.

**`source-discipline.test.ts` is untouched.** Its wall-clock sweep covers the
arena and the page alike: no `Date.now`, no `performance.now`, no delta-time
pacing anywhere in shipped player source, on either side of the fence.

## The cabinet itself

`/play` embeds the reference fighter — `apps/web/public/arena/`, the author's
own prior project, shipped verbatim — in an iframe. Nothing in this document
governs what that game draws: it has its own look, its own audio director and
its own loop, and the page's only messages to it are "sound on/off" and
"pause". The page draws the cabinet around it — the coin slot, the switches,
the controls card — in the style above, so the frame and the screen read as
one machine rather than as a website with a game in a box.
