import { escapeHtml } from '../main';

/**
 * Story 12.4: the cabinet's nav strip.
 *
 * Anchors, not buttons, and that is the whole design. An `<a href="#/play">` is
 * reachable by keyboard with no JavaScript at all, announces itself as a link,
 * pushes a history entry when followed, and survives a copy-paste of the URL.
 * A button would need a click handler, a `tabindex` story, and a second
 * mechanism to make the route linkable -- three things to get right where the
 * platform already has one.
 *
 * The router owns which screen shows; this file owns only what the strip looks
 * like and which link is marked current. `aria-current="page"` rather than a
 * class alone, because "which screen am I on" is exactly the question a screen
 * reader user cannot answer from a lime background.
 */

/** The shape the nav needs of its host and of one link. Structural, per house convention. */
export interface NavNode {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface NavHost {
  innerHTML: string;
  querySelectorAll(selectors: string): readonly NavNode[];
}

export interface NavEntry {
  readonly route: string;
  readonly label: string;
}

/**
 * The strip's markup. Exported so it can be asserted with no DOM, in the same
 * spirit as `arcadeMarkup`/`spectateMarkup`/`landingMarkup`.
 */
export function navMarkup(entries: readonly NavEntry[]): string {
  const links = entries
    .map(
      (entry) =>
        `<a class="tb-nav-link" href="#${escapeHtml(entry.route)}" data-nav-route="${escapeHtml(entry.route)}">${escapeHtml(entry.label)}</a>`,
    )
    .join('');
  return `<nav class="tb-nav" aria-label="Screens">${links}</nav>`;
}

/**
 * Writes the strip into `host` and returns the function that marks the current
 * link. Wired to the router's `onRoute` by `startup.ts`.
 */
export function mountNav(host: NavHost, entries: readonly NavEntry[]): (route: string) => void {
  host.innerHTML = navMarkup(entries);
  const links = host.querySelectorAll('[data-nav-route]');
  return (route: string): void => {
    entries.forEach((entry, index) => {
      const link = links[index];
      if (link === undefined) {
        return;
      }
      if (entry.route === route) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  };
}
