import { escapeHtml } from '../main';
import {
  CABINET_IDS,
  CABINET_ROSTER,
  cabinetFullUrl,
  cabinetPortraitUrl,
  type CabinetId,
} from '../cabinet/roster';
import {
  mountLeaderboardView,
  type FetchLike as LeaderboardFetchLike,
  type LeaderboardReportShape,
  type LeaderboardView,
} from './leaderboard-view';

/**
 * Story 9.8's landing page, rebuilt as the front of the cabinet.
 *
 * The page has three jobs in order: make a visitor want to press the button,
 * show them the fight is real (a real Match, re-simulated, in the motion
 * panel), and say honestly what the benchmark measures and what it does not.
 * The leaderboard stays at the bottom and stays honest: when nothing has
 * cleared the rating floor it says so.
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
  readonly fetch: LeaderboardFetchLike;
  readonly loadLeaderboard?: (fetchImpl: LeaderboardFetchLike) => Promise<LeaderboardReportShape>;
  readonly onPlayCta: () => void;
  readonly onSpectateCta: () => void;
  readonly onByokCta?: () => void;
  readonly onWarning?: (message: string) => void;
}

export interface LandingPanel {
  readonly leaderboard: LeaderboardView;
}

export const HERO_MOTION_URL = '/hero.gif';

const HERO_PAIR: readonly [CabinetId, CabinetId] = ['clawde', 'gemini'];

function rosterStrip(): string {
  return CABINET_IDS.map((id) => {
    const fighter = CABINET_ROSTER[id];
    return `<a class="tb-card tb-roster-tile" href="#/select" data-landing-roster="${id}"><img src="${escapeHtml(cabinetPortraitUrl(id))}" alt="" loading="lazy" /><span>${escapeHtml(fighter.name)}</span></a>`;
  }).join('');
}

export function landingMarkup(): string {
  const [left, right] = HERO_PAIR;
  return `
    <header class="tb-landing-hero">
      <div class="tb-landing-copy">
        <span class="tb-eyebrow">LLM benchmark · arcade cabinet</span>
        <h1 class="tb-landing-title">Token<br />brawl</h1>
        <p class="tb-landing-tagline">Language models fight. The token budget is the health bar.</p>
        <p class="tb-landing-pitch">
          Two models step into a deterministic 1v1 fighter, are polled at the same Decision Points,
          and pay for every thought from a fixed Token Bank. Run dry and you drop into Reflex Mode --
          eight tokens a call and instant, bad decisions. Watch the stream, replay any Match from its
          Command Log, or take the left side of the cabinet and fight the CPU yourself.
        </p>
        <div class="tb-landing-cta-row">
          <button class="tb-button tb-button--gold tb-button--large" type="button" data-landing-play>Insert coin · Play</button>
          <button class="tb-button tb-button--primary tb-button--large" type="button" data-landing-spectate>Watch the stream</button>
          <button class="tb-button tb-button--ghost" type="button" data-landing-byok>Run your own fight</button>
        </div>
        <p class="tb-landing-keys">No server. No signup. Every replay is re-simulated, never recorded.</p>
      </div>
      <div class="tb-landing-art" aria-hidden="true">
        <img class="tb-landing-fighter tb-landing-fighter--p1" src="${escapeHtml(cabinetFullUrl(left))}" alt="" />
        <span class="tb-landing-vs">VS</span>
        <img class="tb-landing-fighter tb-landing-fighter--p2" src="${escapeHtml(cabinetFullUrl(right))}" alt="" />
      </div>
    </header>

    <div class="tb-landing-strip" aria-label="At a glance">
      <div class="tb-card tb-stat"><p class="tb-stat-value">8</p><p class="tb-stat-label">Fighters, each a model family</p></div>
      <div class="tb-card tb-stat"><p class="tb-stat-value">6</p><p class="tb-stat-label">Arenas</p></div>
      <div class="tb-card tb-stat"><p class="tb-stat-value">40</p><p class="tb-stat-label">Decision Points per Match</p></div>
      <div class="tb-card tb-stat"><p class="tb-stat-value">0</p><p class="tb-stat-label">Wall-clock reads in the engine</p></div>
    </div>

    <section class="tb-landing-section" aria-label="Modes">
      <span class="tb-eyebrow">Three ways in</span>
      <h2 class="tb-landing-section-heading">Pick a mode</h2>
      <div class="tb-modes">
        <a class="tb-card tb-mode tb-mode--gold" href="#/play" data-landing-mode="play">
          <span class="tb-mode-kicker">Play</span>
          <h3 class="tb-mode-title">You vs CPU</h3>
          <p class="tb-mode-body">The arcade original, untouched: eight fighters, transformations, a cinematic Ultimate. Keyboard, gamepad or touch. You always take the left side.</p>
          <span class="tb-mode-cta">Insert coin</span>
        </a>
        <a class="tb-card tb-mode" href="#/watch" data-landing-mode="watch">
          <span class="tb-mode-kicker">Watch</span>
          <h3 class="tb-mode-title">The stream</h3>
          <p class="tb-mode-body">An always-on AI-vs-AI channel. Every Match is walked from a committed Command Log in your own tab -- no server, no live inference.</p>
          <span class="tb-mode-cta">Tune in</span>
        </a>
        <a class="tb-card tb-mode" href="#/byok" data-landing-mode="byok">
          <span class="tb-mode-kicker">Run</span>
          <h3 class="tb-mode-title">Your own fight</h3>
          <p class="tb-mode-body">Two free API keys, any OpenAI-compatible endpoint. The fight runs in your browser and the reasoning shows up under the fighters as they think.</p>
          <span class="tb-mode-cta">Bring a key</span>
        </a>
      </div>
    </section>

    <section class="tb-landing-section" aria-label="A real Match">
      <span class="tb-eyebrow">Re-simulated, never recorded</span>
      <h2 class="tb-landing-section-heading">Tokenbrawl in motion</h2>
      <div class="tb-card tb-motion">
        <img class="tb-motion-frame" src="${HERO_MOTION_URL}" alt="A Tokenbrawl Match replaying: two fighters, health and meter bars, a Token Bank draining to zero, and the reasoning behind each Decision Point shown underneath." data-landing-motion />
        <div class="tb-motion-copy">
          <h3>What you are looking at</h3>
          <p>A real Match -- real engine, real frame data, real Token Bank debits, real Command Log -- between a scripted stand-in and a Baseline Bot. Nothing here is a video: the page loads the log and re-runs the deterministic engine, so the fight you watch is exactly the fight that was played.</p>
          <p>The Token Bank under each fighter is the thing being measured. When it hits zero, the model stops thinking and starts flinching.</p>
        </div>
      </div>
    </section>

    <section class="tb-landing-section" aria-label="How the benchmark works">
      <span class="tb-eyebrow">The rules that make the number mean something</span>
      <h2 class="tb-landing-section-heading">How it works</h2>
      <div class="tb-rules">
        <div class="tb-card tb-rule"><h3>Latency-fair</h3><p>The harness blocks on both Agents at every Decision Point and steps once both have answered. Time is Ticks, never a clock. A fast endpoint gains nothing.</p></div>
        <div class="tb-card tb-rule"><h3>Thinking is metered, never set</h3><p>No reasoning-effort knob, no thinking budget. Only the Token Bank constrains a model, and when it runs dry the model enters Reflex Mode.</p></div>
        <div class="tb-card tb-rule"><h3>Deployments, not models</h3><p>A row is a (provider, endpoint, model) triple. Two endpoints serving the same model name are two entrants. A result is a statement about what was called, on the day it was called.</p></div>
        <div class="tb-card tb-rule"><h3>Skill separates first</h3><p>Before any model was rated, the scripted bots had to beat each other in a fixed order by committed margins. A game where skill does not separate cannot measure a model.</p></div>
      </div>
    </section>

    <section class="tb-landing-section" aria-label="Roster">
      <span class="tb-eyebrow">The roster</span>
      <h2 class="tb-landing-section-heading">Eight fighters</h2>
      <div class="tb-roster-strip">${rosterStrip()}</div>
    </section>

    <section class="tb-landing-section tb-landing-leaderboard" aria-label="Leaderboard">
      <span class="tb-eyebrow">Ratings · honest by construction</span>
      <h2 class="tb-landing-section-heading">Leaderboard</h2>
      <p class="tb-landing-section-lede">A pairing is rated only once it has been played enough times and from both sides on mirrored seeds. Below either floor it is provisional and contributes to nothing.</p>
      <div class="tb-card tb-landing-leaderboard-host" data-landing-leaderboard></div>
    </section>
  `;
}

export function mountLandingPanel(host: LandingHost, deps: LandingPanelDeps): LandingPanel {
  host.innerHTML = landingMarkup();

  const playButton = host.querySelector('[data-landing-play]');
  const spectateButton = host.querySelector('[data-landing-spectate]');
  const byokButton = host.querySelector('[data-landing-byok]');
  const leaderboardHost = host.querySelector('[data-landing-leaderboard]');

  if (playButton === null || spectateButton === null || leaderboardHost === null) {
    throw new Error('mountLandingPanel: the panel did not mount.');
  }

  playButton.addEventListener('click', () => {
    deps.onPlayCta();
  });
  spectateButton.addEventListener('click', () => {
    deps.onSpectateCta();
  });
  byokButton?.addEventListener('click', () => {
    deps.onByokCta?.();
  });

  const leaderboard = mountLeaderboardView(leaderboardHost, {
    fetch: deps.fetch,
    ...(deps.loadLeaderboard === undefined ? {} : { loadReport: deps.loadLeaderboard }),
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
  });

  return Object.freeze({ leaderboard });
}
