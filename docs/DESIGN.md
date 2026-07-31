# Tokenbrawl visual design

The style is **neubrutalism on an arcade-dark ground**, decided once in
`ralph-loop.md` and implemented here by Story 4.1. Stories 4.2–4.6 and 7.4
consume it and do not re-decide it — six UI stories built in six sessions is
exactly how a site ends up looking like a template nobody chose.

Everything below is enforced by `apps/web/src/style-discipline.test.ts` where
it can be. The rest is enforced by the Style Auditor review layer.

## Tokens

`apps/web/src/styles/tokens.css` is the single source. A hex literal, a border
width, or a font family written anywhere else is a defect.

| Token | Value | Role |
|---|---|---|
| `--tb-bg` | `#0A0A0A` | ground |
| `--tb-ink` | `#F5F5F0` | every border, every rule, all body text |
| `--tb-accent` | `#C8FF00` | live / active / selected / focused |
| `--tb-warn` | `#FF3B30` | Reflex Track, exclusions, parse failures, hash mismatch |
| `--tb-muted` | `#6E6E68` | metadata only, never body text |

One accent. Lime carries *live*; red carries *excluded/failed*. A third
decorative colour is scope creep.

**Contrast.** Measured against `--tb-bg`: ink 18.1:1, accent 15.7:1, muted
5.42:1 — all clear the 4.5:1 floor. `--tb-warn` on `--tb-bg` measures
**4.26:1 and does not**, so red is used as a border, a fill or a glyph, and
warning *text* is set in `--tb-bg` ink on a red fill instead. Any new pair a
later story introduces must have its measured ratio recorded in that story's
spec.

## Type

- **Display** — Bricolage Grotesque, weight 800, uppercase, `-0.02em`
  tracking. Its width axis is the reason it was chosen; use it.
- **Data** — Departure Mono for every number a visitor reads as data: token
  counts, bank remaining, ticks, ratings and intervals, hashes, model ids.
  Pixel-grid mono against the fighters is deliberate.
- **Body** — Bricolage Grotesque at normal weight. There is no third family.

Both are self-hosted `woff2` under `apps/web/public/fonts/`. No CDN, no
`@import` from a third-party host: the site is static and must render
identically offline and in CI. Licences are recorded in `docs/ASSETS.md`.

## The non-negotiable rules

- **Borders** 3–4px, solid, `--tb-ink`, on everything with an edge.
- **Shadows** hard offset only: `6px 6px 0`. **Zero blur, zero spread, never
  rgba, never layered.** A blurred shadow is the single fastest way to make
  this look generic.
- **Corners** `border-radius: 0`. Everywhere, buttons and inputs included.
- **Fills** flat. No gradient, no glassmorphism, no backdrop blur, no
  translucency, no glow, no `filter`.
- **Interaction** press displaces: on `:active`, translate by the shadow
  offset and collapse the shadow to `0 0`. On `:hover`, invert fill and ink
  rather than tinting.
- **Focus** a visible 3px `--tb-accent` outline with a real offset, on every
  interactive element. Never `outline: none`.
- **Layout** asymmetric and deliberate. Chunky blocks, generous space between
  them, no centred card in the middle of a page. Content may run to the edge.
- **Motion** stepped, `--tb-step` (120ms) or none. No easing curve, no spring,
  no parallax, no scroll-jacking. `prefers-reduced-motion: reduce` sets the
  duration to zero.
- **No CSS framework, no runtime dependency.** `apps/web` has `vite` and
  `vitest` and nothing else.

## Why stepped motion is not a taste decision

**INV-3** says a viewer must not be able to tell how long any Agent took to
think. An animation whose duration varied with the Match would leak precisely
that, so playback advances by a fixed frame count per Decision Point and every
UI transition is a single constant. This is the one style rule that is also an
invariant, and it is why `--tb-step` is a token rather than a per-component
value.
