/**
 * Story 12.4: the screen registry.
 *
 * The list of screens the cabinet has, as data: route, label, and the section
 * each one shows. Separate from `router.ts` (which knows how to switch between
 * screens but not which exist) and from `startup.ts` (which knows what each
 * screen must do when it is shown or hidden, because it holds the panel
 * handles). One place to add a screen, and the nav, the router and the visual
 * gate all read the same list.
 *
 * Order is nav order, and it is the order a visitor meets the product in:
 * the pitch, then the thing they came to do, then the roster, then the two
 * watching surfaces, then the advanced one.
 */

export interface ScreenSpec {
  /** The path half of the hash, leading slash included. */
  readonly route: string;
  /** What the nav strip calls it. */
  readonly label: string;
  /** The section this screen shows. */
  readonly selector: string;
}

/**
 * Every screen, in nav order.
 *
 * `/select` is registered here and its section exists in `index.html`, but the
 * roster is Story 12.5's work: the gate's `character-select-reachable` check
 * fails against the placeholder and is waived to that story. Registering the
 * route now is what gives 12.5 a place to land rather than a shell to
 * renegotiate.
 */
export const SCREENS: readonly ScreenSpec[] = Object.freeze([
  Object.freeze({ route: '/', label: 'Home', selector: '#landing' }),
  Object.freeze({ route: '/play', label: 'Play vs CPU', selector: '#arcade' }),
  Object.freeze({ route: '/select', label: 'Characters', selector: '#select' }),
  Object.freeze({ route: '/watch', label: 'Watch', selector: '#spectate' }),
  Object.freeze({ route: '/replay', label: 'Replay', selector: '#app' }),
  Object.freeze({ route: '/byok', label: 'Own key', selector: '#byok' }),
]);

/** The landing screen. `parseRoute` sends an unknown route here. */
export const ROUTE_HOME = '/';
/** Play vs CPU. Where the landing CTA and a finished character select both go. */
export const ROUTE_PLAY = '/play';
/** Character select. Registered, not built -- Story 12.5. */
export const ROUTE_SELECT = '/select';
/** The Spectate stream. */
export const ROUTE_WATCH = '/watch';
/**
 * The replay player.
 *
 * Also where a finished Match lands: an arcade or BYOK Match re-mounts the
 * player on `#app`, and before this story that happened on whatever section the
 * visitor was scrolled to. On a cabinet it has to be a navigation, or a visitor
 * finishes a fight and is shown a status line saying so with the replay of it
 * playing on a screen they are not on.
 */
export const ROUTE_REPLAY = '/replay';
/** Bring your own key. */
export const ROUTE_BYOK = '/byok';
