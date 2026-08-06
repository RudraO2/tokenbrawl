import { describe, expect, it } from 'vitest';
import {
  LEADERBOARD_REPORT_URL,
  fetchLeaderboardReport,
  leaderboardMarkup,
  mountLeaderboardView,
  validateLeaderboardReport,
  type FetchLike,
  type FetchResponse,
  type LeaderboardViewHost,
} from './leaderboard-view';

/** A fixture shaped like `docs/reports/leaderboard.json`. */
function fixtureReport(): unknown {
  return {
    story: '9-8-marketing-landing-page',
    title: 'Tokenbrawl leaderboard',
    generatedBy: 'tokenbrawl leaderboard --config configs/tournament.config.json',
    corpus: '2 committed Command Logs',
    environment: { id: 'fighter-1v1', version: '1.0.0' },
    configHash: 'abc123',
    matches: 2,
    ratedMatches: 2,
    excludedMatches: 0,
    exclusionTotals: [],
    bootstrap: { method: 'percentile', resamples: 2000, seed: 1, confidenceBasisPoints: 9500 },
    mainLeaderboard: [
      {
        agent: 'deployment:clawde',
        kind: 'deployment',
        track: 'main',
        matches: 10,
        ratingBasisPoints: 15234,
        ciLowerBasisPoints: 14000,
        ciUpperBasisPoints: 16500,
        opponents: [],
      },
      {
        agent: 'bot:aggressive',
        kind: 'bot',
        track: 'main',
        matches: 10,
        ratingBasisPoints: 10000,
        ciLowerBasisPoints: 9000,
        ciUpperBasisPoints: 11000,
        opponents: [],
      },
    ],
    reflexTrack: [],
    unrated: [],
    coverage: [],
    behaviour: [],
    headline: 'The scripted Baseline Bot `bot:aggressive` outranks 0 of 1 Deployment in the main leaderboard.',
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return { ok, status, json: async () => body };
}

function createHost(): LeaderboardViewHost {
  const state = { html: '' };
  return {
    get innerHTML(): string {
      return state.html;
    },
    set innerHTML(value: string) {
      state.html = value;
    },
  };
}

describe('validateLeaderboardReport', () => {
  it('accepts a well-formed report fixture', () => {
    const report = validateLeaderboardReport(fixtureReport());
    expect(report.mainLeaderboard).toHaveLength(2);
    expect(report.mainLeaderboard[0].agent).toBe('deployment:clawde');
  });

  it('accepts the current empty-mainLeaderboard shape docs/reports/leaderboard.json ships today', () => {
    const report = validateLeaderboardReport({
      title: 'Tokenbrawl leaderboard',
      headline: null,
      mainLeaderboard: [],
      reflexTrack: [],
    });
    expect(report.mainLeaderboard).toHaveLength(0);
  });

  it('rejects a non-object document', () => {
    expect(() => validateLeaderboardReport('nope')).toThrow(/must be an object/);
  });

  it('rejects a malformed row missing a required field', () => {
    expect(() =>
      validateLeaderboardReport({
        title: 't',
        headline: null,
        mainLeaderboard: [{ agent: 'x' }],
        reflexTrack: [],
      }),
    ).toThrow(/kind/);
  });

  it('rejects an unrecognised kind or track', () => {
    expect(() =>
      validateLeaderboardReport({
        title: 't',
        headline: null,
        mainLeaderboard: [
          {
            agent: 'x',
            kind: 'human',
            track: 'main',
            matches: 1,
            ratingBasisPoints: 0,
            ciLowerBasisPoints: 0,
            ciUpperBasisPoints: 0,
          },
        ],
        reflexTrack: [],
      }),
    ).toThrow(/kind/);
  });
});

describe('leaderboardMarkup', () => {
  it('renders a clean empty state for null (unavailable)', () => {
    expect(leaderboardMarkup(null)).toContain('data-leaderboard-empty');
  });

  it('renders a clean empty state for zero ranked entries', () => {
    const report = validateLeaderboardReport({
      title: 't',
      headline: null,
      mainLeaderboard: [],
      reflexTrack: [],
    });
    expect(leaderboardMarkup(report)).toContain('data-leaderboard-empty');
  });

  it('renders ranked entries from the fixture, in report order', () => {
    const report = validateLeaderboardReport(fixtureReport());
    const markup = leaderboardMarkup(report);
    expect(markup).toContain('data-leaderboard-table');
    const tableStart = markup.indexOf('data-leaderboard-table');
    const clawdeIndex = markup.indexOf('deployment:clawde', tableStart);
    const aggressiveIndex = markup.indexOf('bot:aggressive', tableStart);
    expect(clawdeIndex).toBeLessThan(aggressiveIndex);
    expect(markup).toContain('data-leaderboard-headline');
  });
});

describe('fetchLeaderboardReport', () => {
  it(`fetches ${LEADERBOARD_REPORT_URL} and validates the result`, async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(fixtureReport());
    const report = await fetchLeaderboardReport(fetchImpl);
    expect(report.mainLeaderboard).toHaveLength(2);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, false, 500);
    await expect(fetchLeaderboardReport(fetchImpl)).rejects.toThrow(/HTTP 500/);
  });
});

describe('mountLeaderboardView', () => {
  it('renders ranked entries from a fixture with no additional server call beyond the one static fetch', async () => {
    const host = createHost();
    let loadCalls = 0;
    const view = mountLeaderboardView(host, {
      fetch: async () => jsonResponse({}),
      loadReport: async () => {
        loadCalls += 1;
        return validateLeaderboardReport(fixtureReport());
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(loadCalls).toBe(1);
    expect(view.rowCount()).toBe(2);
    expect(host.innerHTML).toContain('deployment:clawde');
  });

  it('fails soft on a malformed report -- warns, never throws', async () => {
    const host = createHost();
    const warnings: string[] = [];
    expect(() =>
      mountLeaderboardView(host, {
        fetch: async () => jsonResponse({}),
        loadReport: async () => {
          throw new Error('bad report');
        },
        onWarning: (message) => warnings.push(message),
      }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings.some((message) => message.includes('bad report'))).toBe(true);
  });
});
