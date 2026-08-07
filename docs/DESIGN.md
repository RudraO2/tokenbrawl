# Tokenbrawl visual design

The style is **neubrutalism on an arcade-dark ground**, decided once in
`ralph-loop.md` and implemented here by Story 4.1. Stories 4.2–4.6 and 7.4
consume it and do not re-decide it — six UI stories built in six sessions is
exactly how a site ends up looking like a template nobody chose.

Everything below is enforced by `apps/web/src/style-discipline.test.ts` where
it can be. The rest is enforced by the Style Auditor review layer.

## Tokens

`apps/web/src/styles/tokens.css` is where the **page** declares colour. A hex
literal written anywhere else in page chrome is a defect. Border widths and
font families are declared here too, and those two rules are global rather than
page-scoped — see "Geometry and type stay global" under "Two regimes" below.

Exactly two other files may hold a colour literal, both named in
`apps/web/src/style-discipline.test.ts` rather than pattern-matched:

- `apps/web/src/render/theme.ts` — the canvas mirror of the five tokens below.
  A canvas cannot cheaply read a CSS custom property, so the values are copied,
  and the same test asserts every copy still appears in `tokens.css`.
- `apps/web/src/render/arena-palette.ts` — the **arena's** colours, which are
  not brand tokens at all. See "Two regimes" below for why that file exists and
  what it is allowed to contain.

Neither is an exemption from having a palette. A raw hex literal at a call
site fails the sweep on both sides of the boundary.

One hex lives outside all three, and deliberately: `apps/web/index.html`
declares the ground colour inline so the first paint is already dark. The
suite pins it to `--tb-bg` and allows no second one.

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

This floor is about **text**, and it does not govern the values in
`render/arena-palette.ts` — see "Two regimes" below for what does.

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

## Two regimes: the page and the arena

**The ruling, 2026-08-07.** Everything above was written for the UI. It was
never a decision that it should also govern the game drawn inside the UI —
*"All the rules that we have made for design.md and other things were for the
UI not for the game itself inside Token Brawl."* The canvas half of the
flat-surface ban arrived by accident: Story 4.1's sprite artist painted
`globalAlpha = 0.55` across a whole 600×600 frame, a red pane over a third of
the arena, and the fastest way to stop *that* was to point the stylesheet's
rule at the drawing code too. The goal it collided with is a close copy of a
next-gen arena fighter — and a fighting game's impact reads through light, and
light is alpha.

So Story 11.1 **narrowed the fence rather than removing it**. Page chrome keeps
every rule in the list above, unchanged. The arena is released from three of
them.

**Where the boundary runs.** Every non-test **`.ts`** file under
**`apps/web/src/render/`** is the arena. Everything else in `apps/web/src` is
the page. It is a directory and not a per-file allowlist because `render/` is
already exactly the set of files that draw the fight, and an allowlist would
need an entry added by four separate stories — a boundary that every story
edits is not a boundary. `apps/web/src/style-discipline.test.ts` holds the same
boundary as one named constant, `ARENA_BOUNDARY`, and pins the arena's exact
membership in one assertion, so a file joining it is a reviewable act rather
than a side effect of where it was put.

**`.ts` and not `.css`.** A stylesheet cannot draw on a canvas, so a
`render/hud.css` would be page chrome wearing the arena's directory name.
There is none today and the boundary will not release one. "`.ts`" means every
TypeScript spelling — `.ts`, `.tsx`, `.mts`, `.cts` — and the file walk collects
exactly those, because a file the walk reaches but the boundary cannot classify
(or the reverse) would sit outside every rule in the suite rather than on one
side of the fence.

**`render/theme.ts` is inside the directory and is not released.** It holds the
five flat *brand* colours as the canvas mirror of `tokens.css`, and brand is
page. Releasing the file that defines flatness from the flatness rules is the
same leak as a `render/hud.css`. It stays inside the boundary for *membership* —
the exact-list ratchet and the wall-clock sweep still cover it — and
`style-discipline.test.ts` names it `BRAND_MIRROR` for the two rules that skip
it.

**The one non-obvious call: `hero/` stays on the page side.** It drives a
canvas too, but what it produces is a landing-page asset — the hero raster —
rather than a surface a Match is played on. It keeps every flat-surface rule.
`arcade/`, `spectate/`, `landing/` and `byok/` are page too: they are DOM
panels that *host* a canvas, and every pixel of the fight inside one is drawn
by `render/`. Story 11.3's arcade HUD therefore lands in `render/` despite its
name, because the HUD is drawn on the canvas.

**Four rules were audited, and all four were settled at once** — because an
epic that settles one and hits the next a story later has settled nothing.
Three were settled by scoping or by adding a source. The fourth was settled by
deciding that it **stays**, on both sides, and by naming exactly what Story
11.3 must do if it wants to change that. A rule with a stated price is settled;
a rule a later story may quietly reopen is not.

| Rule | What it blocked | Resolution |
|---|---|---|
| No translucent or blurred surface — `rgba(`, `linear-gradient`, `radial-gradient`, `backdrop-filter`, `filter: blur`, inset shadow | Every glow, vignette, aura and health-bar gradient | **Scoped to page files.** Arena released. |
| No partial alpha — `globalAlpha` set to anything but `1` | Every additive and glow layer | **Scoped to page files.** `render/backdrop.ts`'s named exemption is now redundant and is kept deliberately, because it records *why* one file dims the scenery. |
| Every hex literal lives in a declared colour source | The reference's gold, its three health tiers, its super meter, and one aura colour per fighter — none of them brand tokens | **Rule kept; a third source added.** `render/arena-palette.ts` joins `tokens.css` and `theme.ts`. A raw hex inside the arena still fails. |
| The two chosen faces and no third family | An arcade display face for HUD numerals and callouts | **Kept, on both sides, and deferred.** Story 11.3 must either render arcade type from a glyph table the way `hero/font.ts` already does, or add a third `@font-face` **and** amend the rule and `docs/ASSETS.md` in the same change. It may not drift in behind the boundary. |

**Two rules looked like clashes and were not.** *"Blurs no shadow"* is anchored
on the CSS `box-shadow:` declaration, so the canvas's `shadowBlur` property was
never covered by it. *"Rounds no corner"* is anchored on the CSS
`border-radius:` declaration, so a rounded path on the canvas was never covered
either. Both stay unscoped. Recording that here is the point — an unexplained
omission reads as an oversight to the next story that trips over it.

**Geometry and type stay global.** The boundary released three *colour and
compositing* rules and nothing else. Border widths, hard shadow offsets, square
corners, stepped motion, the two typefaces and the offline guarantee apply on
both sides — the arena follows the reference's layout, but it does not get to
introduce a third font or a remote asset by being the arena.

**The 4.5:1 text floor does not govern the arena palette; a 3:1 sanity check
does.** The floor recorded above is about **text a visitor reads**. Every value
in `render/arena-palette.ts` is a fill, a gradient stop or a glow, so text
ratios are deliberately not recorded for them. That is not the same as
unmeasured: a health bar and a super meter are the two most information-bearing
objects on the screen, so WCAG 1.4.11's 3:1 floor for graphical objects is the
check that was applied instead, and it changed one value — the reference's
near-black brand colour for one fighter measures 1.12:1 against the ground and
cannot function as a glow, so it was lifted (to 7.80:1). The module records the
reference value, the measurement and the replacement. That check was run
against the **stage**, which is the surface the auras are seen on; `hudPlate`
is a backing rather than a shape to be seen, measures 1.00:1 against the ground
by design, and the ratio that governs it is bar-against-plate — Story 11.3 owns
recording those when it draws the plate. Any *text* a later story draws on
the canvas still answers to the 4.5:1 floor and must record its ratio the same
way page text does.

**`source-discipline.test.ts` is untouched.** Its wall-clock sweep, its
`deltaTime` ban and its module-level-mutable-binding ban are not style rules —
they are what makes the benchmark's claims true (INV-1, INV-3), and they are
what forbid copying the reference's simulation freeze, its stepped particle
pool, its ungoverned RNG and its audio wall clocks. Story 11.1 relaxed **style**
rules only, and `style-discipline.test.ts` carries a case that reads that file's
source to prove no `render/` path was parked in its exemption list and that its
walk still reaches every arena file. A story that finds itself wanting to relax
`source-discipline.test.ts` has misread the epic and must stop and escalate.

## Why stepped motion is not a taste decision

**INV-3** says a viewer must not be able to tell how long any Agent took to
think. An animation whose duration varied with the Match would leak precisely
that, so playback advances by a fixed frame count per Decision Point and every
UI transition is a single constant. This is the one style rule that is also an
invariant, and it is why `--tb-step` is a token rather than a per-component
value.
