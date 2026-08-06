import { describe, expect, it } from 'vitest';
import { mountLandingPanel, type LandingHost, type LandingNode } from './panel';
import type { FetchResponse } from './carousel';

/** Structural fake, same discipline `spectate/panel.test.ts` uses. */
interface FakeHost extends LandingHost {
  readonly fire: (selector: string, type: 'click') => void;
}

function createHost(): FakeHost {
  const nodes = new Map<string, LandingNode>();
  const listeners = new Map<string, (() => void)[]>();
  const state = { html: '' };

  const child = (selector: string): LandingNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: LandingNode = {
      innerHTML: '',
      addEventListener: (type, listener): void => {
        const key = `${selector}:${type}`;
        listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      },
    };
    nodes.set(selector, node);
    return node;
  };

  return {
    get innerHTML(): string {
      return state.html;
    },
    set innerHTML(value: string) {
      state.html = value;
    },
    querySelector: (selector: string): LandingNode | null => child(selector),
    fire: (selector: string, type: 'click'): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener();
      }
    },
  };
}

function jsonResponse(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

describe('mountLandingPanel', () => {
  it('mounts the shell -- pitch, CTAs, carousel host and leaderboard host -- synchronously', () => {
    const host = createHost();
    mountLandingPanel(host, {
      fetch: async () => jsonResponse({}),
      loadClipManifest: async () => ({ schemaVersion: '1.0.0', clips: [] }),
      loadLeaderboard: async () => ({ title: 't', headline: null, mainLeaderboard: [], reflexTrack: [] }),
      onPlayCta: () => undefined,
      onSpectateCta: () => undefined,
    });
    expect(host.innerHTML).toContain('data-landing-play');
    expect(host.innerHTML).toContain('data-landing-spectate');
    expect(host.innerHTML).toContain('data-landing-carousel');
    expect(host.innerHTML).toContain('data-landing-leaderboard');
  });

  it('wires the Play-vs-CPU CTA to the injected callback -- no key, no signup', () => {
    const host = createHost();
    let playCalls = 0;
    mountLandingPanel(host, {
      fetch: async () => jsonResponse({}),
      loadClipManifest: async () => ({ schemaVersion: '1.0.0', clips: [] }),
      loadLeaderboard: async () => ({ title: 't', headline: null, mainLeaderboard: [], reflexTrack: [] }),
      onPlayCta: () => {
        playCalls += 1;
      },
      onSpectateCta: () => undefined,
    });
    host.fire('[data-landing-play]', 'click');
    expect(playCalls).toBe(1);
  });

  it('wires the Spectate CTA to the injected callback', () => {
    const host = createHost();
    let spectateCalls = 0;
    mountLandingPanel(host, {
      fetch: async () => jsonResponse({}),
      loadClipManifest: async () => ({ schemaVersion: '1.0.0', clips: [] }),
      loadLeaderboard: async () => ({ title: 't', headline: null, mainLeaderboard: [], reflexTrack: [] }),
      onPlayCta: () => undefined,
      onSpectateCta: () => {
        spectateCalls += 1;
      },
    });
    host.fire('[data-landing-spectate]', 'click');
    expect(spectateCalls).toBe(1);
  });

  it('mounts a working carousel and leaderboard view beneath the shell, from injected loaders', async () => {
    const host = createHost();
    const panel = mountLandingPanel(host, {
      fetch: async () => jsonResponse({}),
      loadClipManifest: async () => ({
        schemaVersion: '1.0.0',
        clips: [{ id: 'a', src: '/marketing-clips/a.mp4', duration: 5 }],
      }),
      loadLeaderboard: async () => ({
        title: 't',
        headline: null,
        mainLeaderboard: [
          {
            agent: 'deployment:clawde',
            kind: 'deployment',
            track: 'main',
            matches: 1,
            ratingBasisPoints: 15000,
            ciLowerBasisPoints: 14000,
            ciUpperBasisPoints: 16000,
          },
        ],
        reflexTrack: [],
      }),
      onPlayCta: () => undefined,
      onSpectateCta: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.carousel.clipCount()).toBe(1);
    expect(panel.leaderboard.rowCount()).toBe(1);
  });

  it('renders the carousel empty state cleanly when the manifest has no clips', async () => {
    const host = createHost();
    mountLandingPanel(host, {
      fetch: async () => jsonResponse({}),
      loadClipManifest: async () => ({ schemaVersion: '1.0.0', clips: [] }),
      loadLeaderboard: async () => ({ title: 't', headline: null, mainLeaderboard: [], reflexTrack: [] }),
      onPlayCta: () => undefined,
      onSpectateCta: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    const carouselHostMarkup = host.querySelector('[data-landing-carousel]')?.innerHTML ?? '';
    expect(carouselHostMarkup).toContain('data-carousel-empty');
    expect(carouselHostMarkup).not.toContain('<canvas');
  });

  it('throws if the host is missing an expected mount point', () => {
    const brokenHost: LandingHost = {
      innerHTML: '',
      querySelector: () => null,
    };
    expect(() =>
      mountLandingPanel(brokenHost, {
        fetch: async () => jsonResponse({}),
        onPlayCta: () => undefined,
        onSpectateCta: () => undefined,
      }),
    ).toThrow(/did not mount/);
  });
});
