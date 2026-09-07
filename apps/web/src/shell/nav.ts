import { escapeHtml } from '../main';

/**
 * Story 12.4. The nav strip: the brand mark, then one link per screen. The
 * router tells it which one is current; it marks that link and nothing else.
 */

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

export function navMarkup(entries: readonly NavEntry[]): string {
  const links = entries
    .map(
      (entry) =>
        `<a class="tb-nav-link" href="#${escapeHtml(entry.route)}" data-nav-route="${escapeHtml(entry.route)}">${escapeHtml(entry.label)}</a>`,
    )
    .join('');
  return `<nav class="tb-nav" aria-label="Screens"><a class="tb-nav-brand" href="#/" data-nav-brand><span class="tb-nav-coin" aria-hidden="true"></span><span>Tokenbrawl</span></a><div class="tb-nav-links">${links}</div></nav>`;
}

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
