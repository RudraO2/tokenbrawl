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
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  save(): void;
  restore(): void;
}
