import { describe, expect, it } from 'vitest';
import {
  ACTIVE_ATTRIBUTE,
  createScreenRouter,
  DEFAULT_ROUTE,
  parseRoute,
  type Screen,
  type ScreenElement,
  type ShellView,
} from './router';
import { navMarkup } from './nav';
import { SCREENS } from './screens';

/**
 * Story 12.4. The router, tested against fakes rather than a DOM.
 *
 * The three properties worth pinning are the three the story names: exactly one
 * screen shows, a hidden screen is told to stop, and the hash is the source of
 * truth so a reload and the back button both work. Everything else here is a
 * consequence of those.
 */

/** A section element that records the attribute the router moves. */
function fakeElement(): ScreenElement & { active: () => boolean } {
  const state = { active: false };
  return {
    setAttribute: (name: string): void => {
      if (name === ACTIVE_ATTRIBUTE) {
        state.active = true;
      }
    },
    removeAttribute: (name: string): void => {
      if (name === ACTIVE_ATTRIBUTE) {
        state.active = false;
      }
    },
    active: (): boolean => state.active,
  };
}

/**
 * A view whose hash can be set, and whose history can be walked.
 *
 * The back button is modelled the way a browser implements it: assigning the
 * hash pushes an entry, `back()` pops to the previous one and fires
 * `hashchange`. Testing the real thing needs a real browser; testing this
 * exercises every line the router owns.
 */
function fakeView(initialHash = ''): ShellView & {
  back: () => void;
  forward: () => void;
  fire: () => void;
} {
  const listeners: (() => void)[] = [];
  const history: { entries: string[]; index: number } = { entries: [initialHash], index: 0 };
  const fire = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const location = {
    get hash(): string {
      return history.entries[history.index] ?? '';
    },
    set hash(next: string) {
      if (history.entries[history.index] === next) {
        return;
      }
      history.entries = [...history.entries.slice(0, history.index + 1), next];
      history.index = history.entries.length - 1;
      fire();
    },
  };
  return {
    location,
    addEventListener: (_type: 'hashchange', listener: () => void): void => {
      listeners.push(listener);
    },
    removeEventListener: (_type: 'hashchange', listener: () => void): void => {
      const at = listeners.indexOf(listener);
      if (at >= 0) {
        listeners.splice(at, 1);
      }
    },
    back: (): void => {
      if (history.index > 0) {
        history.index -= 1;
        fire();
      }
    },
    forward: (): void => {
      if (history.index < history.entries.length - 1) {
        history.index += 1;
        fire();
      }
    },
    fire,
  };
}

interface Harness {
  readonly screens: Screen[];
  readonly elements: Map<string, ReturnType<typeof fakeElement>>;
  readonly log: string[];
}

function harness(routes: readonly string[] = ['/', '/play', '/watch']): Harness {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const log: string[] = [];
  const screens = routes.map((route) => {
    const element = fakeElement();
    elements.set(route, element);
    return {
      route,
      label: route,
      element,
      onShow: (): void => {
        log.push(`show ${route}`);
      },
      onHide: (): void => {
        log.push(`hide ${route}`);
      },
    };
  });
  return { screens, elements, log };
}

const shownRoutes = (h: Harness): string[] =>
  [...h.elements.entries()].filter(([, element]) => element.active()).map(([route]) => route);

describe('parseRoute', () => {
  const known = ['/', '/play', '/watch'];

  it('reads the path out of a hash', () => {
    expect(parseRoute('#/play', known)).toBe('/play');
  });

  it('treats an empty hash and a bare # as the visitor who typed the address', () => {
    expect(parseRoute('', known)).toBe(DEFAULT_ROUTE);
    expect(parseRoute('#', known)).toBe(DEFAULT_ROUTE);
  });

  it('lands an unknown route on the landing screen rather than on a blank page', () => {
    // The failure this replaces is not a 404 -- it is a viewport with every
    // screen hidden, which reads as a site that failed to load.
    expect(parseRoute('#/nope', known)).toBe(DEFAULT_ROUTE);
    expect(parseRoute('#/play/extra', known)).toBe(DEFAULT_ROUTE);
    expect(parseRoute('#section-anchor', known)).toBe(DEFAULT_ROUTE);
  });
});

describe('the screen router', () => {
  it('shows exactly one screen for every route, including an unknown one', () => {
    for (const hash of ['', '#/', '#/play', '#/watch', '#/nonsense']) {
      const h = harness();
      createScreenRouter({ view: fakeView(hash), screens: h.screens });
      expect(shownRoutes(h)).toHaveLength(1);
    }
  });

  it('applies the hash it was constructed with, so a reload lands where it left off', () => {
    const h = harness();
    const router = createScreenRouter({ view: fakeView('#/watch'), screens: h.screens });
    expect(router.current()).toBe('/watch');
    expect(shownRoutes(h)).toStrictEqual(['/watch']);
  });

  it('stops the clocks of every screen it is not showing, on the very first apply', () => {
    // The mounts have all run and started by the time the router is built, so
    // this is where every clock but one is stopped. Without it the page is
    // still three canvases animating at once, whatever the layout says -- and
    // the first version of this router did exactly that, because it only hid
    // the screen it had just left and on the first apply there is no such
    // screen. An independent review caught it. The case that was here then was
    // written against the behaviour rather than the claim in its own name, so
    // it passed on the defect; this one fails on it.
    const h = harness();
    createScreenRouter({ view: fakeView('#/play'), screens: h.screens });
    expect(h.log.filter((line) => line.startsWith('hide'))).toStrictEqual(['hide /', 'hide /watch']);
    // And the shown screen is not re-started: it was already running.
    expect(h.log).not.toContain('show /play');

    const later = harness();
    const router = createScreenRouter({ view: fakeView('#/play'), screens: later.screens });
    later.log.length = 0;
    router.go('/watch');
    expect(later.log).toStrictEqual(['hide /play', 'show /watch']);
  });

  it('hides every other screen on a load straight at the landing route', () => {
    // The default entry point, and the one the broken version got wrong.
    const h = harness();
    createScreenRouter({ view: fakeView(''), screens: h.screens });
    expect(h.log).toStrictEqual(['hide /play', 'hide /watch']);
  });

  it('stops a screen exactly once, however many times it is passed over', () => {
    const h = harness();
    const router = createScreenRouter({ view: fakeView(''), screens: h.screens });
    h.log.length = 0;
    router.go('/play');
    router.go('/watch');
    router.go('/play');
    // Every entry is a real transition: no screen is stopped twice and none is
    // started while it is already running. And every hide precedes its show,
    // which is what stops the outgoing screen's teardown from silencing the
    // shared audio graph the incoming screen has just claimed.
    expect(h.log).toStrictEqual([
      'hide /',
      'show /play',
      'hide /play',
      'show /watch',
      'hide /watch',
      'show /play',
    ]);
  });

  it('fires no callback for a navigation to the screen already showing', () => {
    const h = harness();
    const router = createScreenRouter({ view: fakeView('#/play'), screens: h.screens });
    h.log.length = 0;
    router.go('/play');
    expect(h.log).toStrictEqual([]);
  });

  it('carries the route in the URL', () => {
    const view = fakeView('');
    const h = harness();
    const router = createScreenRouter({ view, screens: h.screens });
    router.go('/watch');
    expect(view.location.hash).toBe('#/watch');
    expect(router.current()).toBe('/watch');
  });

  it('follows a hash the visitor typed, or a link they clicked', () => {
    const view = fakeView('');
    const h = harness();
    const router = createScreenRouter({ view, screens: h.screens });
    view.location.hash = '#/play';
    expect(router.current()).toBe('/play');
    expect(shownRoutes(h)).toStrictEqual(['/play']);
  });

  it('moves back and forward through the screen history', () => {
    const view = fakeView('');
    const h = harness();
    const router = createScreenRouter({ view, screens: h.screens });
    router.go('/play');
    router.go('/watch');
    expect(router.current()).toBe('/watch');

    view.back();
    expect(router.current()).toBe('/play');
    expect(shownRoutes(h)).toStrictEqual(['/play']);

    view.back();
    expect(router.current()).toBe('/');
    expect(shownRoutes(h)).toStrictEqual(['/']);

    view.forward();
    expect(router.current()).toBe('/play');
  });

  it('routes around a screen whose section is missing rather than throwing', () => {
    // Every panel here mounts warn-not-throw, so a page missing one section is
    // a configuration the router has to survive.
    const log: string[] = [];
    const screens: Screen[] = [
      { route: '/', label: 'Home', element: fakeElement() },
      {
        route: '/play',
        label: 'Play',
        element: null,
        onHide: (): void => {
          log.push('hide /play');
        },
        onShow: (): void => {
          log.push('show /play');
        },
      },
    ];
    const view = fakeView('#/play');
    const router = createScreenRouter({ view, screens });
    expect(router.current()).toBe('/play');
    // Nothing to hide on the screen with no element, and nothing to show on
    // the one that is already running -- but its callbacks still fire on a
    // real transition, so a missing section costs the visitor nothing but the
    // section.
    expect(log).toStrictEqual([]);
    router.go('/');
    router.go('/play');
    expect(log).toStrictEqual(['hide /play', 'show /play']);
  });

  it('refuses to build without a landing screen, because an unknown route would have nowhere to land', () => {
    expect(() =>
      createScreenRouter({
        view: fakeView(''),
        screens: [{ route: '/play', label: 'Play', element: fakeElement() }],
      }),
    ).toThrow(/no screen registered/);
  });

  it('reports the current route to its chrome exactly once per change', () => {
    const seen: string[] = [];
    const h = harness();
    const router = createScreenRouter({
      view: fakeView(''),
      screens: h.screens,
      onRoute: (route) => seen.push(route),
    });
    router.go('/play');
    router.go('/play');
    expect(seen).toStrictEqual(['/', '/play']);
  });

  it('stops listening when told to', () => {
    const view = fakeView('');
    const h = harness();
    const router = createScreenRouter({ view, screens: h.screens });
    router.stop();
    view.location.hash = '#/watch';
    expect(router.current()).toBe('/');
  });
});

describe('the registry and the nav strip agree', () => {
  it('registers a landing route, so an unknown hash has somewhere to land', () => {
    expect(SCREENS.map((screen) => screen.route)).toContain(DEFAULT_ROUTE);
  });

  it('registers every section index.html carries, and each exactly once', () => {
    const routes = SCREENS.map((screen) => screen.route);
    expect(new Set(routes).size).toBe(routes.length);
    const selectors = SCREENS.map((screen) => screen.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(selectors).toStrictEqual(['#landing', '#arcade', '#select', '#spectate', '#app', '#byok']);
  });

  it('links every screen with a real hash href, so the keyboard reaches all of them', () => {
    const markup = navMarkup(SCREENS.map((s) => ({ route: s.route, label: s.label })));
    for (const screen of SCREENS) {
      expect(markup).toContain(`href="#${screen.route}"`);
      expect(markup).toContain(screen.label);
    }
    // Anchors, not buttons: keyboard-reachable and linkable with no script.
    expect(markup).not.toContain('<button');
  });
});

/**
 * Story 12.4, from an independent review: the page has one audio graph, shared
 * by every surface, so "stop making sound" is a screen touching a shared thing.
 * Interleaved with the registry's own order, the outgoing screen's teardown
 * would run *after* the incoming screen's setup and silence the surface that
 * had just claimed the buses.
 */
describe('a screen is always stopped before the next one starts', () => {
  it('runs every hide before any show, whatever order the registry is in', () => {
    const log: string[] = [];
    const make = (route: string): Screen => ({
      route,
      label: route,
      element: fakeElement(),
      onShow: (): void => {
        log.push(`show ${route}`);
      },
      onHide: (): void => {
        log.push(`hide ${route}`);
      },
    });
    // `/watch` sits *before* `/replay` here, which is the real registry order
    // and the order that produced the bug: showing Watch would have claimed
    // the buses, and hiding Replay would then have stopped them.
    const screens = [make('/'), make('/watch'), make('/replay')];
    const router = createScreenRouter({ view: fakeView('#/replay'), screens });
    log.length = 0;
    router.go('/watch');
    expect(log).toStrictEqual(['hide /replay', 'show /watch']);
  });
});
