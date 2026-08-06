import {
  mountCarousel,
  type CarouselHost,
  type CarouselPanel,
  type ClipManifest,
  type FetchLike as ClipFetchLike,
} from './carousel';
import {
  mountLeaderboardView,
  type FetchLike as LeaderboardFetchLike,
  type LeaderboardReportShape,
  type LeaderboardView,
} from './leaderboard-view';

/**
 * Story 9.8: the landing page.
 *
 * The capstone of Epic 9 -- the first above-the-fold experience a visitor
 * with no context lands on (FR-38, UJ-5). It assembles four things this file
 * does not itself compute: pitch copy, the clip carousel (`carousel.ts`), the
 * leaderboard view (`leaderboard-view.ts`), and two CTAs into the panels
 * `startup.ts` already mounts. Mirrors `arcade/panel.ts`'s/`spectate/panel.ts`'s
 * `mount*Panel(host, deps)` shape: its own host (`#landing`), structural DOM
 * interfaces throughout (`tsconfig.base.json` has no DOM lib).
 *
 * This module deliberately knows nothing about `ArcadePanel` or
 * `SpectatePanel`'s own types -- the CTAs are two injected callbacks
 * (`onPlayCta`, `onSpectateCta`), wired by `startup.ts`, which is the one
 * place that already holds both panel handles. That keeps this file testable
 * with a bare function and keeps `startup.ts` the single place that decides
 * what "activate Arcade" or "activate Spectate" means.
 */

export type LandingEvent = 'click';

export interface LandingNode {
  innerHTML: string;
  addEventListener(type: LandingEvent, listener: () => void): void;
}

export interface LandingHost {
  innerHTML: string;
  querySelector(selectors: string): LandingNode | null;
}

export interface LandingPanelDeps {
  readonly fetch: ClipFetchLike & LeaderboardFetchLike;
  /** Injectable so a test can supply a clip manifest with no network at all. */
  readonly loadClipManifest?: (fetchImpl: ClipFetchLike) => Promise<ClipManifest>;
  /** Injectable so a test can supply a leaderboard report fixture with no network at all. */
  readonly loadLeaderboard?: (fetchImpl: LeaderboardFetchLike) => Promise<LeaderboardReportShape>;
  /** Fired when the visitor clicks "Play vs CPU" here. Wired by `startup.ts` to the real Arcade panel. */
  readonly onPlayCta: () => void;
  /** Fired when the visitor clicks "Watch Spectate" here. Wired by `startup.ts` to the real Spectate panel. */
  readonly onSpectateCta: () => void;
  readonly onWarning?: (message: string) => void;
}

export interface LandingPanel {
  readonly carousel: CarouselPanel;
  readonly leaderboard: LeaderboardView;
}

/**
 * The panel's markup. Exported so the shell -- pitch copy, CTA buttons, and
 * the two sub-mount points -- can be asserted with no DOM, in the same spirit
 * as `arcadeMarkup`/`spectateMarkup`.
 */
export function landingMarkup(): string {
  return `
    <header class="tb-landing-hero">
      <h1 class="tb-landing-title">Tokenbrawl</h1>
      <p class="tb-landing-tagline">
        A fair head-to-head harness where compute budget is an adversarial in-match resource.
      </p>
      <p class="tb-landing-pitch">
        Two language models fight in a deterministic 1v1 fighting game, polled at the same Decision
        Points, each spending from a fixed Token Bank to answer. Run dry and you enter Reflex Mode --
        an eight-token cap and instant, bad decisions. Every Match replays from a committed Command Log,
        never from a wall clock, so the fight you watch is exactly the fight that was played.
      </p>
      <div class="tb-landing-cta-row">
        <button class="tb-button tb-landing-cta-play" type="button" data-landing-play>
          Play vs CPU
        </button>
        <button class="tb-button tb-landing-cta-spectate" type="button" data-landing-spectate>
          Watch Spectate
        </button>
      </div>
    </header>
    <section class="tb-landing-carousel" aria-label="Fight clips">
      <h2 class="tb-landing-section-heading">Tokenbrawl in motion</h2>
      <div class="tb-landing-carousel-host" data-landing-carousel></div>
    </section>
    <section class="tb-landing-leaderboard" aria-label="Leaderboard">
      <h2 class="tb-landing-section-heading">Leaderboard</h2>
      <div class="tb-landing-leaderboard-host" data-landing-leaderboard></div>
    </section>
  `;
}

/**
 * Mounts the landing panel and wires its two CTAs immediately -- neither CTA
 * depends on the carousel or leaderboard fetch resolving, the same
 * critical-path discipline `startup.ts`'s own bootstrap follows: a visitor
 * must be able to click "Play vs CPU" the instant the page paints, not after
 * a network round trip for decoration.
 */
export function mountLandingPanel(host: LandingHost, deps: LandingPanelDeps): LandingPanel {
  host.innerHTML = landingMarkup();

  const playButton = host.querySelector('[data-landing-play]');
  const spectateButton = host.querySelector('[data-landing-spectate]');
  const carouselHost = host.querySelector('[data-landing-carousel]');
  const leaderboardHost = host.querySelector('[data-landing-leaderboard]');

  if (playButton === null || spectateButton === null || carouselHost === null || leaderboardHost === null) {
    throw new Error('mountLandingPanel: the panel did not mount.');
  }

  playButton.addEventListener('click', () => {
    deps.onPlayCta();
  });
  spectateButton.addEventListener('click', () => {
    deps.onSpectateCta();
  });

  const carousel = mountCarousel(carouselHost as unknown as CarouselHost, {
    fetch: deps.fetch,
    ...(deps.loadClipManifest === undefined ? {} : { loadManifest: deps.loadClipManifest }),
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
  });

  const leaderboard = mountLeaderboardView(leaderboardHost, {
    fetch: deps.fetch,
    ...(deps.loadLeaderboard === undefined ? {} : { loadReport: deps.loadLeaderboard }),
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
  });

  return Object.freeze({ carousel, leaderboard });
}
