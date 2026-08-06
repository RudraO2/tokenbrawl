import { escapeHtml } from '../main';

/**
 * Story 9.8: the landing page's leaderboard view.
 *
 * Reads the same generated report `packages/cli/src/leaderboard.ts` writes to
 * `docs/reports/leaderboard.json` -- this module is a read-only consumer and
 * neither computes nor invents any rating of its own. `docs/reports/` sits
 * outside `apps/web`'s static root, so it cannot be fetched by a visitor's
 * browser as-is (INV-8: static hosting only, no build-time server). A copy is
 * committed at `apps/web/public/leaderboard.json` instead -- the same "commit
 * a static file, fetch it same-origin" shape `spectate/manifest.ts` and
 * `startup.ts`'s `DEMO_REPLAY_URL` already use, not a new mechanism. Keeping
 * that copy in sync with `docs/reports/leaderboard.json` is a manual step for
 * whoever regenerates the report (the same discipline the tournament
 * workflow already applies to `apps/web/public/replays` versus its own
 * source of truth); this file does not, and must not, reach into `docs/` at
 * runtime.
 */

export interface LeaderboardRow {
  readonly agent: string;
  readonly kind: 'deployment' | 'bot';
  readonly track: 'main' | 'reflex';
  readonly matches: number;
  readonly ratingBasisPoints: number;
  readonly ciLowerBasisPoints: number;
  readonly ciUpperBasisPoints: number;
}

export interface LeaderboardReportShape {
  readonly title: string;
  readonly headline: string | null;
  readonly mainLeaderboard: readonly LeaderboardRow[];
  readonly reflexTrack: readonly LeaderboardRow[];
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface FetchLike {
  (url: string): Promise<FetchResponse>;
}

function fail(message: string): never {
  throw new Error(`Invalid leaderboard report: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where}.${field} must be a non-empty string.`);
  }
  return value as string;
}

function requireInteger(source: Record<string, unknown>, field: string, where: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${where}.${field} must be a number.`);
  }
  return value as number;
}

function requireTrack(source: Record<string, unknown>, where: string): 'main' | 'reflex' {
  const value = source['track'];
  if (value !== 'main' && value !== 'reflex') {
    fail(`${where}.track must be "main" or "reflex".`);
  }
  return value;
}

function requireKind(source: Record<string, unknown>, where: string): 'deployment' | 'bot' {
  const value = source['kind'];
  if (value !== 'deployment' && value !== 'bot') {
    fail(`${where}.kind must be "deployment" or "bot".`);
  }
  return value;
}

function parseRow(raw: unknown, where: string): LeaderboardRow {
  const source = asRecord(raw, where);
  return Object.freeze({
    agent: requireString(source, 'agent', where),
    kind: requireKind(source, where),
    track: requireTrack(source, where),
    matches: requireInteger(source, 'matches', where),
    ratingBasisPoints: requireInteger(source, 'ratingBasisPoints', where),
    ciLowerBasisPoints: requireInteger(source, 'ciLowerBasisPoints', where),
    ciUpperBasisPoints: requireInteger(source, 'ciUpperBasisPoints', where),
  });
}

function parseRows(raw: unknown, where: string): readonly LeaderboardRow[] {
  if (!Array.isArray(raw)) {
    fail(`${where} must be an array.`);
  }
  return Object.freeze(raw.map((entry, index) => parseRow(entry, `${where}[${String(index)}]`)));
}

/**
 * Structurally validates a fetched leaderboard report.
 *
 * Deliberately not full JSON-Schema validation, the same posture
 * `spectate/manifest.ts` takes toward its own generated document: this file
 * is written by this repo's own CLI, never by a visitor, so a hand-written
 * shape check is proportionate.
 */
export function validateLeaderboardReport(candidate: unknown): LeaderboardReportShape {
  const source = asRecord(candidate, 'the report');
  const title = requireString(source, 'title', 'the report');
  const headlineRaw = source['headline'];
  if (headlineRaw !== null && typeof headlineRaw !== 'string') {
    fail('the report.headline must be a string or null.');
  }
  const mainLeaderboard = parseRows(source['mainLeaderboard'], 'the report.mainLeaderboard');
  const reflexTrack = parseRows(source['reflexTrack'], 'the report.reflexTrack');

  return Object.freeze({
    title,
    headline: headlineRaw,
    mainLeaderboard,
    reflexTrack,
  });
}

/** The committed static copy of `docs/reports/leaderboard.json` -- see this file's docblock. */
export const LEADERBOARD_REPORT_URL = '/leaderboard.json';

export async function fetchLeaderboardReport(fetchImpl: FetchLike): Promise<LeaderboardReportShape> {
  const response = await fetchImpl(LEADERBOARD_REPORT_URL);
  if (!response.ok) {
    throw new Error(`could not load ${LEADERBOARD_REPORT_URL} (HTTP ${String(response.status)})`);
  }
  return validateLeaderboardReport(await response.json());
}

function formatBasisPoints(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

function rowMarkup(row: LeaderboardRow, rank: number): string {
  return `
    <tr class="tb-leaderboard-row">
      <td class="tb-leaderboard-cell">${String(rank)}</td>
      <td class="tb-leaderboard-cell">${escapeHtml(row.agent)}</td>
      <td class="tb-leaderboard-cell">${escapeHtml(row.kind)}</td>
      <td class="tb-leaderboard-cell">${formatBasisPoints(row.ratingBasisPoints)}</td>
      <td class="tb-leaderboard-cell">${formatBasisPoints(row.ciLowerBasisPoints)} – ${formatBasisPoints(row.ciUpperBasisPoints)}</td>
      <td class="tb-leaderboard-cell">${String(row.matches)}</td>
    </tr>
  `;
}

/**
 * The leaderboard view's markup, ranked by table order (the report already
 * publishes `mainLeaderboard` sorted -- this module reorders nothing).
 * Exported so the shell can be asserted with no DOM, in the same spirit as
 * `spectateMarkup`/`arcadeMarkup`.
 */
export function leaderboardMarkup(report: LeaderboardReportShape | null): string {
  if (report === null) {
    return `<p class="tb-leaderboard-empty" data-leaderboard-empty>Leaderboard unavailable.</p>`;
  }
  if (report.mainLeaderboard.length === 0) {
    return `
      <p class="tb-leaderboard-empty" data-leaderboard-empty>
        No Match has cleared the rating floor yet -- every entrant below is still provisional.
      </p>
    `;
  }
  const headline =
    report.headline === null
      ? ''
      : `<p class="tb-leaderboard-headline" data-leaderboard-headline>${escapeHtml(report.headline)}</p>`;
  const rows = report.mainLeaderboard.map((row, index) => rowMarkup(row, index + 1)).join('');
  return `
    ${headline}
    <table class="tb-leaderboard-table" data-leaderboard-table>
      <thead>
        <tr>
          <th class="tb-leaderboard-cell">Rank</th>
          <th class="tb-leaderboard-cell">Agent</th>
          <th class="tb-leaderboard-cell">Kind</th>
          <th class="tb-leaderboard-cell">Rating</th>
          <th class="tb-leaderboard-cell">95% CI</th>
          <th class="tb-leaderboard-cell">Matches</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

export interface LeaderboardViewHost {
  innerHTML: string;
}

export interface LeaderboardViewDeps {
  readonly fetch: FetchLike;
  /** Injectable so a test can supply a report fixture with no network at all. */
  readonly loadReport?: (fetchImpl: FetchLike) => Promise<LeaderboardReportShape>;
  readonly onWarning?: (message: string) => void;
}

export interface LeaderboardView {
  readonly rowCount: () => number;
}

/**
 * Mounts the leaderboard view and returns immediately; the report fetch
 * happens in the background, the same critical-path discipline
 * `spectate/panel.ts` and `carousel.ts` follow.
 */
export function mountLeaderboardView(host: LeaderboardViewHost, deps: LeaderboardViewDeps): LeaderboardView {
  host.innerHTML = leaderboardMarkup(null);

  const state: { report: LeaderboardReportShape | null } = { report: null };

  const loadReport = deps.loadReport ?? fetchLeaderboardReport;

  void (async (): Promise<void> => {
    try {
      const report = await loadReport(deps.fetch);
      state.report = report;
      host.innerHTML = leaderboardMarkup(report);
    } catch (error) {
      deps.onWarning?.(
        `Leaderboard unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  return Object.freeze({
    rowCount: (): number => state.report?.mainLeaderboard.length ?? 0,
  });
}
