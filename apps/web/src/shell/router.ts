/**
 * Story 12.4: the screen router.
 *
 * `index.html` used to be five sibling sections in document order -- `#landing`,
 * `#app`, `#byok`, `#arcade`, `#spectate` -- every one of them mounted and
 * running at once, forever. There was no screen concept, no route, and no way
 * to be *on* the arcade rather than scrolled to it; Story 9.8's landing CTAs
 * were `scrollTo('#arcade')` calls, which was the honest expression of what the
 * page was. Three canvases animated simultaneously on a phone.
 *
 * This module owns three things and deliberately nothing else:
 *
 * 1. **Which screen is showing.** Exactly one. The others carry no
 *    `data-screen-active` attribute, so the stylesheet gives them
 *    `display: none` and therefore a zero-area bounding box.
 * 2. **What a hidden screen is allowed to do.** Each screen may declare
 *    `onHide`/`onShow`, and that is where a clock is stopped and resumed. This
 *    is the half of the story that is not about layout: it is what makes the
 *    page cheap enough to run on a phone.
 * 3. **How you got there.** A hash route, so a screen is linkable and the back
 *    button works. No history rewriting -- assigning `location.hash` pushes an
 *    entry and fires `hashchange`, which is the whole mechanism. INV-8 holds:
 *    a hash route is served by the same static file, where a path route would
 *    need a server rewrite.
 *
 * What it is *not*: a framework, a component model, or an owner of what any
 * panel draws inside itself. The panels stay exactly the panels they are, with
 * the mount functions `startup.ts` already calls.
 *
 * Every DOM type here is structural, per house convention -- `tsconfig.base.json`
 * has no DOM lib and must not gain one (see `byok/panel.ts`'s docblock for why).
 */

/** The route a visitor lands on with no hash, and the fallback for an unknown one. */
export const DEFAULT_ROUTE = '/';

/**
 * The attribute the stylesheet keys visibility off.
 *
 * An attribute rather than a class because the sections carry author-written
 * classes already (`tb-landing`, `tb-arcade`, ...) and a router that edited
 * `className` would have to preserve them by hand -- one substring bug away
 * from deleting a panel's whole styling.
 */
export const ACTIVE_ATTRIBUTE = 'data-screen-active';

/** What the router needs of a screen's section element: two attribute calls. */
export interface ScreenElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** What the router needs of the page's view: the hash, and notice when it changes. */
export interface ShellView {
  readonly location: { hash: string };
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener?(type: 'hashchange', listener: () => void): void;
}

export interface Screen {
  /** The path half of the hash, leading slash included: `/play` for `#/play`. */
  readonly route: string;
  /** What the nav calls it. */
  readonly label: string;
  /**
   * The section this screen shows, or `null` when the page carries no host for
   * it. A `null` element is not an error -- `startup.ts` mounts every panel
   * warn-not-throw, so a page missing one section must still route around it.
   */
  readonly element: ScreenElement | null;
  /**
   * Called when this screen stops showing. This is where a clock stops: a
   * hidden screen that keeps painting is the defect this story exists to fix.
   */
  readonly onHide?: () => void;
  /** Called when this screen starts showing. The inverse of `onHide`. */
  readonly onShow?: () => void;
}

export interface ScreenRouter {
  /** The route currently showing. Always one of the registered routes. */
  readonly current: () => string;
  /** Navigates, pushing a history entry so the back button returns here. */
  readonly go: (route: string) => void;
  /** Re-reads the hash and applies it. Called on `hashchange`; exposed for tests. */
  readonly sync: () => void;
  /** Detaches the `hashchange` listener. For tests and for a future teardown. */
  readonly stop: () => void;
}

export interface ScreenRouterDeps {
  readonly view: ShellView;
  readonly screens: readonly Screen[];
  /**
   * Called after every applied navigation with the route now showing, so the
   * nav can mark its current link. Kept as a callback rather than owned here:
   * the router decides *which* screen, never what the chrome around it looks
   * like.
   */
  readonly onRoute?: (route: string) => void;
}

/**
 * Reads a route out of a location hash.
 *
 * Pure and exported because it is the one piece of string arithmetic here worth
 * pinning: an unknown route must land on the landing screen rather than on a
 * blank page, and "blank page" is exactly what a router that returned the
 * unmatched string would produce.
 */
export function parseRoute(hash: string, known: readonly string[]): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  // A bare `#` and an empty hash are the same visitor: one who typed the
  // site's address.
  const candidate = raw.length === 0 ? DEFAULT_ROUTE : raw;
  return known.includes(candidate) ? candidate : DEFAULT_ROUTE;
}

/**
 * Builds the router and applies the current hash immediately.
 *
 * Applying on construction rather than on the first `hashchange` is what makes
 * a reload land on the screen it was on: a router that waited for an event
 * would show the landing screen to anyone who reloaded `#/watch`, which is a
 * tab strip rather than a route.
 *
 * The initial apply fires `onHide` for every screen that is not showing, which
 * is deliberate: the panels have all mounted and started by the time this runs,
 * so the first thing the router does is stop four of the five clocks the page
 * just started.
 */
export function createScreenRouter(deps: ScreenRouterDeps): ScreenRouter {
  const { view, screens } = deps;
  const routes = screens.map((screen) => screen.route);

  if (!routes.includes(DEFAULT_ROUTE)) {
    throw new Error(
      `createScreenRouter: no screen registered at ${DEFAULT_ROUTE}, so an unknown route would have nowhere to land.`,
    );
  }

  // Closure state inside a factory rather than a module-level binding, which is
  // the house pattern and what `source-discipline.test.ts` enforces. `''` is
  // not a route, so the first apply always counts as a change.
  const state = { route: '' };

  const apply = (route: string): void => {
    if (state.route === route) {
      return;
    }
    const previous = state.route;
    state.route = route;
    for (const screen of screens) {
      const showing = screen.route === route;
      if (showing) {
        screen.element?.setAttribute(ACTIVE_ATTRIBUTE, '');
      } else {
        screen.element?.removeAttribute(ACTIVE_ATTRIBUTE);
      }
      // Only on a transition. Calling `onShow` on the screen that was already
      // showing would restart a clock the visitor deliberately paused.
      if (showing && screen.route !== previous) {
        screen.onShow?.();
      }
      if (!showing && screen.route === previous) {
        screen.onHide?.();
      }
    }
    deps.onRoute?.(route);
  };

  const sync = (): void => {
    apply(parseRoute(view.location.hash, routes));
  };

  const listener = (): void => {
    sync();
  };
  view.addEventListener('hashchange', listener);

  sync();

  return Object.freeze({
    current: (): string => state.route,
    go: (route: string): void => {
      const target = routes.includes(route) ? route : DEFAULT_ROUTE;
      const hash = `#${target}`;
      // Assigning the hash is what pushes the history entry, and it fires
      // `hashchange` asynchronously. `apply` is also called directly, because
      // assigning a hash the location already carries fires nothing at all --
      // without this, `go` to the current route after a manual DOM change would
      // silently do nothing. `apply` is idempotent, so the later event is a
      // no-op.
      view.location.hash = hash;
      apply(target);
    },
    sync,
    stop: (): void => {
      view.removeEventListener?.('hashchange', listener);
    },
  });
}
