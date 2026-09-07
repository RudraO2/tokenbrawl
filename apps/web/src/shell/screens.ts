/**
 * Story 12.4. The cabinet's screens: one route, one label, one element.
 *
 * The order here is the order of the nav. `#arcade` keeps its id because the
 * router, the visual gate and index.html all name it; what it hosts is the
 * Play cabinet.
 */
export interface ScreenSpec {
  readonly route: string;
  readonly label: string;
  readonly selector: string;
}

export const SCREENS: readonly ScreenSpec[] = Object.freeze([
  Object.freeze({ route: '/', label: 'Home', selector: '#landing' }),
  Object.freeze({ route: '/play', label: 'Play', selector: '#arcade' }),
  Object.freeze({ route: '/select', label: 'Fighters', selector: '#select' }),
  Object.freeze({ route: '/watch', label: 'Watch', selector: '#spectate' }),
  Object.freeze({ route: '/replay', label: 'Replay', selector: '#app' }),
  Object.freeze({ route: '/byok', label: 'Your keys', selector: '#byok' }),
]);

export const ROUTE_HOME = '/';
export const ROUTE_PLAY = '/play';
export const ROUTE_SELECT = '/select';
export const ROUTE_WATCH = '/watch';
export const ROUTE_REPLAY = '/replay';
export const ROUTE_BYOK = '/byok';
