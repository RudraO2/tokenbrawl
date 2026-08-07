/**
 * The narrowest 2D drawing surface this player needs.
 *
 * Deliberately not `CanvasRenderingContext2D`. Two reasons, and the second is
 * the load-bearing one:
 *
 * 1. `tsconfig.base.json` sets `lib: ["ES2022"]` with no DOM. `apps/web`'s own
 *    tsconfig adds DOM back, but naming the real type here would bind every
 *    consumer -- tests included -- to whichever ambient declaration happens to
 *    be installed.
 * 2. A narrow interface is what lets every drawing assertion run under
 *    Vitest's default `node` environment against a recording fake. No `jsdom`,
 *    no `canvas` native module, no new dependency, and the assertions are about
 *    the exact call sequence rather than about pixels nobody reads.
 *
 * `CanvasRenderingContext2D` satisfies this structurally, so the real context
 * is passed straight in with no adapter.
 */
export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  /**
   * Nearest-neighbour when false. The sheet is pixel art at 64x96 and is drawn
   * larger than that, so smoothing turns crisp edges to mush -- the one canvas
   * setting that decides whether this looks like a sprite or like a blurred
   * shape.
   */
  imageSmoothingEnabled: boolean;
  globalAlpha: number;
  /**
   * How a draw is combined with what is already on the surface. Story 11.2.
   *
   * The port stayed deliberately narrow for ten stories and this is the first
   * thing that actually needed widening, so the reason is worth writing down:
   * **impact reads as light, and light is additive**. A spark sheet drawn with
   * `'source-over'` composites as a grey-brown smear over the stage because
   * every dark pixel in the cell paints; with `'lighter'` the dark pixels
   * contribute nothing and the bright core stacks into the fighters behind it,
   * which is what a hit looks like. Nothing else in this app sets it:
   * `paintImpacts` sets it once around its whole loop and puts back whatever
   * it found -- not `'source-over'`, which is merely the value it is usually
   * handed. Anything drawn *inside* that loop composites additively, so a
   * later non-additive draw belongs outside it or needs its own pair.
   *
   * A `string` rather than a union of the composite-operation names, for the
   * same reason the whole interface is structural: naming the DOM's own
   * `GlobalCompositeOperation` type would bind every consumer -- tests
   * included -- to whichever ambient declaration happens to be installed.
   * `CanvasRenderingContext2D` satisfies this structurally, so nothing adapts.
   */
  globalCompositeOperation: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  /** The 9-argument form only: a sprite is always a sub-rectangle of a sheet. */
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
}
