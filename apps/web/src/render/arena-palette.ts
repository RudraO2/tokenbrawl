/**
 * Story 11.1: the arena's colours, declared in exactly one place.
 *
 * ## Why a second palette exists at all
 *
 * `styles/tokens.css` and `render/theme.ts` hold the *brand*: five colours,
 * one accent, chosen once in `docs/DESIGN.md` so that six UI stories built in
 * six sessions could not each pick their own. That palette is still the only
 * palette the page is allowed to use, and nothing here changes it.
 *
 * The owner ruled on 2026-08-07 that those rules were written for the UI and
 * not for the game inside it -- *"All the rules that we have made for
 * design.md and other things were for the UI not for the game itself inside
 * Token Brawl."* A fighting game's health bar is a three-tier gradient, its
 * super meter pulses gold at full, and every fighter carries an aura colour
 * that is theirs rather than the site's. None of those are brand tokens, and
 * forcing them through `--tb-accent` would produce a lime health bar.
 *
 * So the arena gets its own palette -- **and it is still a palette**. Story
 * 11.1 released `apps/web/src/render/` from the *brand* colour rule, not from
 * the rule that colour is declared rather than typed at a call site: a raw hex
 * literal anywhere else under `render/` still fails
 * `style-discipline.test.ts`. This module is the third and last file permitted
 * to hold a colour *literal* in `apps/web`, and it is listed there by name.
 *
 * "Literal" is the exact word. `render/identity.ts` derives a `#rrggbb` at
 * runtime by hashing a Deployment (see below), and no text sweep can see a
 * colour that is computed -- so the rule buys "no colour is typed at a call
 * site", which is what makes a palette a palette, and not "every colour in the
 * arena is in this file". The one derived colourway is deliberate, documented
 * and has been since Story 9.4.
 *
 * ## These are effect colours, and the contrast floor does not govern them
 *
 * `docs/DESIGN.md` records a measured 4.5:1 contrast floor against `--tb-bg`
 * and requires any new pair a story introduces to record its ratio. That floor
 * is about **text a visitor reads**. Every value below is a fill, a gradient
 * stop or a glow -- a health bar's green, an aura, the plate a HUD element
 * sits on -- and none of it is body copy. The 4.5:1 floor is therefore
 * deliberately not applied to this palette, which is a decision rather than an
 * omission; `docs/DESIGN.md`'s "Two regimes" section says the same thing in
 * prose so that a reader does not have to find this comment to learn it. Any
 * *text* drawn on the canvas in a later story still answers to the floor, and
 * must record its ratio the same way page text does.
 *
 * "Not a text floor" is not the same as "unmeasured", and one value below was
 * changed because of a measurement -- see `aura.grokk`. A health bar and a
 * super meter are the two most information-bearing objects on the screen, and
 * WCAG 1.4.11's 3:1 floor for graphical objects is the right sanity check for
 * them even though the 4.5:1 text floor is not.
 *
 * Be exact about what that check was run against, because a ratio needs two
 * colours and only one of them is a palette entry. It was run for the values a
 * viewer sees **against the stage** -- the auras, which glow over the backdrop
 * and the ground. `hudPlate` is deliberately not one of them: it is a *backing*
 * surface, and at `#080a10` it measures 1.00:1 against `--tb-bg` by design, the
 * plate being a darkening rather than a shape to be seen. The ratio that
 * matters for it is bar-against-plate (`hpHigh.to` on `hudPlate` is 7.60:1),
 * and Story 11.3 owns recording those when it composites the plate at the 85%
 * alpha noted below. Ratios here are the standard WCAG 2.x relative-luminance
 * formula against `--tb-bg` `#0a0a0a`, so they reproduce.
 *
 * ### The bar-against-plate ratios, recorded (Story 11.3)
 *
 * Line 60 above deferred these to the story that actually draws the plate.
 * `render/hud.ts` now does, so they are written down here rather than in the
 * drawing code, because a ratio is a fact about two palette entries and the
 * palette is where a reader looks for one. Each is the bar's saturated stop
 * measured against `hudPlate`, by the same relative-luminance formula:
 *
 * | Pair | Ratio |
 * |---|---|
 * | `hpHigh.to` on `hudPlate` | 7.60:1 |
 * | `hpMid.to` on `hudPlate` | 7.65:1 |
 * | `hpLow.to` on `hudPlate` | 3.35:1 |
 * | `superMeter.to` on `hudPlate` | 6.29:1 |
 * | `superMeterFull.to` on `hudPlate` | 8.61:1 |
 * | `hudFrame` on `hudPlate` | 3.36:1 |
 *
 * All six clear WCAG 1.4.11's 3:1 floor for a graphical object, which is the
 * floor that governs a health bar and a super meter -- see "These are effect
 * colours" above for why the 4.5:1 *text* floor is deliberately not the one
 * applied. `hpLow` is the tightest of them at 3.35:1 and that is the correct
 * ordering: the last tier is meant to read as blood rather than as a signal.
 *
 * **The plate is drawn opaque here, not at the reference's 85%.** The alpha is
 * recorded below as provenance, and it is deliberately not honoured. The hero
 * renderer (`hero/raster.ts`) is a second real `Canvas2D` over a buffer of
 * palette *indices*: there is no channel arithmetic for a composite to do, so
 * an 85% plate would either quantise to something nobody chose or force the
 * HUD to fork in two. Drawing it opaque makes the ratios above exact rather
 * than approximate, and it is the reason they are quoted against `hudPlate`
 * itself rather than against a blend of `hudPlate` and the stage.
 *
 * ## Nothing draws with any of this yet
 *
 * Story 11.1 moves a fence and draws nothing. On the day it lands the only
 * importer is `style-discipline.test.ts`, which asserts the palette's shape --
 * so the module is referenced, but nothing draws with it, and that is the
 * intended state: 11.2 (impact FX), 11.3 (arcade HUD) and 11.4 (the three-act
 * Ultimate) are the stories that consume it. Adding the colours in the same
 * change that moved the fence is what makes the fence checkable -- the "arena
 * still needs a palette" rule has something to point at.
 *
 * ## Provenance
 *
 * Transliterated from the reference arcade fighter named in
 * `docs/DEV-REFERENCE.md`, which is the same owner's prior project and which
 * E11 treats as the target rather than as a sketch. Cited by file and line so
 * a later story does not have to re-derive them:
 *
 * Paths are relative to `<REF>`, the reference project's root, which
 * `docs/DEV-REFERENCE.md` names. It is outside this repository and its
 * absolute path may appear in Markdown only, which is why it is not written
 * out here.
 *
 * - `<REF>/game_source/js/screens.js:45` -- `GOLD`, the arcade gold. The win
 *   banner and the Ultimate's key art. Note that the *full* super meter is
 *   `superMeterFull` below, a gradient rather than this flat gold: the
 *   reference fills the segments with `grad.supGold` and reserves the flat
 *   `GOLD` for type and strokes.
 * - `<REF>/game_source/js/screens.js:2281` -- `HP_PLATE`, the dark plate the
 *   health and meter bars are drawn onto. The reference composites it at 85%
 *   alpha over the stage; only the colour is recorded here, because the alpha
 *   belongs to the draw call that 11.3 will write and not to the palette. The
 *   number is written down in this sentence so 11.3 does not have to re-open
 *   the reference to recover it.
 * - `<REF>/game_source/js/screens.js:2328-2332` -- the three health tiers and
 *   the two super-meter gradients, each a two-stop vertical gradient built by
 *   `hudVGrad`. Kept as `from`/`to` pairs rather than flattened to a single
 *   colour, because the tier reads as a tier precisely because of the ramp.
 *   `hpMid` and `superMeterFull` are near-identical golds in the reference and
 *   are copied that way deliberately -- they never share a bar, and diverging
 *   from the reference to "fix" a similarity it chose is not this epic's job.
 * - `<REF>/game_source/js/screens.js:2333` -- the reference's `mana` ramp, the
 *   violet bar it draws for its third spendable resource. Story 11.3 takes it
 *   for the **Token Bank**, which is this project's third resource and sits in
 *   the same position in the same column. Named `bank` rather than `mana`
 *   because the name should say what it meters here.
 * - `<REF>/game_source/js/screens.js:2455` -- the bevel and frame the reference
 *   strokes its bars with, and the damage-lag ghost it fills them with. All
 *   three are `rgba(255,255,255,α)` over the stage there; they arrive here as
 *   the opaque colours that composite resolves to over `hudPlate`, because
 *   `hero/raster.ts` stores palette indices and cannot blend. `hudGhost` is the
 *   0.35 white, `hudBevel` the lit top edge, `hudFrame` the 0.2 outline.
 * - `<REF>/game_source/js/data.js:87,102,117,132` -- one `brandHex` per
 *   fighter, for the four in this project's roster.
 *
 * `hpMid` and `superMeterFull` being near-identical is the reason the
 * uniqueness assertion in `style-discipline.test.ts` is on *values* and not on
 * "colours that look alike": two names for one exact value is a palette
 * drifting, and two names for two close-but-distinct values is the reference's
 * own choice being kept. If a later tier ever needs a value another entry
 * already holds, that assertion is the thing to re-argue -- not the colour.
 *
 * ## Aura is per-character; `identity.ts`'s colourway is per-Deployment
 *
 * `render/identity.ts` (Story 9.4) already derives a `#rrggbb` per Deployment
 * by hashing `(provider, endpoint, model)`, and draws it as an emblem. That is
 * a different question from this one: the emblem answers *which Deployment is
 * this*, the aura answers *which fighter is this*. They coexist in the
 * reference too. The first story that draws both at once (11.2 or 11.4) owns
 * the decision about which one a glow takes its colour from; nothing is
 * decided here beyond recording that both exist.
 *
 * Lowercased on the way across to match `render/theme.ts`, which writes its
 * five brand colours lowercase; a palette that mixed both cases would make
 * every future "is this colour already declared?" grep a two-pattern search.
 *
 * ## What is deliberately absent
 *
 * No import of anything under `packages/`, and no import at all: a palette
 * that depends on the simulation is a palette that cannot be read by a test
 * without booting one. This file is shipped, so `source-discipline.test.ts`
 * sweeps it like every other shipped file -- no wall clock, no `deltaTime`, no
 * module-level `let` or `var`. `const` and `Object.freeze` throughout, which
 * is also how `theme.ts` states that a palette is not a mutable global.
 */

/**
 * A two-stop vertical gradient, top stop first.
 *
 * The reference's `hudVGrad` (`game_source/js/screens.js:2302`) builds these
 * against a canvas context, which a palette module cannot do -- a
 * `CanvasGradient` is bound to the context that made it, and this file must
 * stay loadable under the `node` test environment where there is no context at
 * all. So the two stops are recorded as data and the drawing story builds the
 * gradient at the point of use.
 */
export interface ArenaGradient {
  /** The top stop -- the lighter end in every tier below. */
  readonly from: string;
  /** The bottom stop -- the saturated end that gives the bar its weight. */
  readonly to: string;
}

/** One aura colour per fighter in this project's four-character roster (Story 9.7). */
export interface ArenaAura {
  readonly clawde: string;
  readonly chatty: string;
  readonly gemini: string;
  readonly grokk: string;
}

export interface ArenaPalette {
  /** Arcade gold. The full super meter, the win banner, the Ultimate's key art. */
  readonly gold: string;
  /** The dark plate the HUD bars sit on. Drawn opaque by `render/hud.ts` -- see the docblock. */
  readonly hudPlate: string;
  /** The skewed outline around every HUD bar. 3.36:1 on `hudPlate`. */
  readonly hudFrame: string;
  /** The lit top row of a filled bar, which is what makes it read as bevelled. */
  readonly hudBevel: string;
  /** The damage-lag layer behind the live health bar: a chip receding to the new value. */
  readonly hudGhost: string;
  /** Health above the first tier boundary. */
  readonly hpHigh: ArenaGradient;
  /** Health in the middle tier -- the warning that a round is turning. */
  readonly hpMid: ArenaGradient;
  /** Health in the last tier, where one exchange ends the round. */
  readonly hpLow: ArenaGradient;
  /** The super meter while it is filling. */
  readonly superMeter: ArenaGradient;
  /** The super meter at full, which is the cue that an Ultimate is available. */
  readonly superMeterFull: ArenaGradient;
  /** The Token Bank meter -- the reference's third-resource violet, renamed for what it meters. */
  readonly bank: ArenaGradient;
  /** Per-fighter aura, for glows and Ultimate FX that must read as *whose*. */
  readonly aura: ArenaAura;
}

/**
 * The arena palette. Frozen, and frozen one level down as well -- a shallow
 * `Object.freeze` leaves `ARENA_PALETTE.hpHigh.from` writable, which is the
 * whole failure mode a frozen palette exists to prevent.
 */
export const ARENA_PALETTE: ArenaPalette = Object.freeze({
  gold: '#ffd24a',
  hudPlate: '#080a10',
  hudFrame: '#5a6480',
  hudBevel: '#cfd8e6',
  hudGhost: '#f2f5fa',
  hpHigh: Object.freeze({ from: '#8cf3b5', to: '#1fb85c' }),
  hpMid: Object.freeze({ from: '#ffe08a', to: '#c99a16' }),
  hpLow: Object.freeze({ from: '#ff8a8a', to: '#c41e1e' }),
  superMeter: Object.freeze({ from: '#7fefff', to: '#0e9fb8' }),
  superMeterFull: Object.freeze({ from: '#ffe58a', to: '#d9a21a' }),
  bank: Object.freeze({ from: '#b9a7ff', to: '#6e5bd8' }),
  aura: Object.freeze({
    clawde: '#d97706',
    chatty: '#10a37f',
    gemini: '#4285f4',
    // The one value not copied straight across, and the reason is measurable.
    // The reference's `brandHex` for this fighter is `#111827`, a near-black
    // that measures **1.12:1** against this project's `--tb-bg` ground
    // (`#0a0a0a`) -- an aura darker than the stage it glows over is not an
    // aura. Lifted to a neutral of the same cool-grey family at **7.80:1**,
    // which clears WCAG 1.4.11's 3:1 floor for a graphical object that carries
    // meaning. This is the epic's "modified minimally" clause doing exactly
    // what it is for: the reference draws this fighter on lighter stages than
    // Tokenbrawl has.
    grokk: '#9ca3af',
  }),
});
