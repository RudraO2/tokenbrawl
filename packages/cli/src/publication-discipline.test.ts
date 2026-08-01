import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Story 7-2, AC1, second sentence: **no raw win table is ever published
 * without CIs.**
 *
 * That is a claim about every artefact this repository publishes, not about one
 * renderer, so it is checked here over the committed files themselves. A future
 * story that hand-writes a win-rate table into `docs/reports/` -- 7.4's honest
 * claims are the obvious candidate -- never passes through
 * `renderLeaderboardMarkdown` and would satisfy every test in `packages/core`
 * while publishing exactly what this criterion forbids.
 *
 * It lives in `packages/cli` because this package already owns the repo-root
 * discipline sweeps (`workflow-discipline.test.ts`, `secret-leak-script.test.ts`)
 * and can read the repository without breaking any package's import rules.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPORTS_DIRECTORY = join(REPO_ROOT, 'docs', 'reports');

/**
 * A column header that offers the reader a rate to compare Agents by. These are
 * the words this repo's reports actually use; a table that invents a fourth
 * synonym is a table this sweep will miss, which is why the rule is *also*
 * enforced structurally by there being one renderer.
 */
const RATE_COLUMNS: readonly string[] = ['rating', 'win rate', 'score', 'strength'];

/** What a stated confidence interval is called in a header. */
const INTERVAL_COLUMNS: readonly string[] = ['ci', 'interval', 'confidence'];

interface MarkdownTable {
  readonly file: string;
  readonly line: number;
  readonly header: string;
  readonly rows: readonly string[];
}

function reportFiles(): readonly string[] {
  return readdirSync(REPORTS_DIRECTORY)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

/** Every pipe table in a Markdown file, as a header plus its data rows. */
function tablesIn(file: string): readonly MarkdownTable[] {
  const lines = readFileSync(join(REPORTS_DIRECTORY, file), 'utf8').split('\n');
  const tables: MarkdownTable[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index];
    const rule = lines[index + 1];
    if (!header.startsWith('|') || rule === undefined || !/^\|[\s-|]+\|$/.test(rule)) {
      continue;
    }
    const rows: string[] = [];
    for (let row = index + 2; row < lines.length && lines[row].startsWith('|'); row += 1) {
      rows.push(lines[row]);
    }
    tables.push({ file, line: index + 1, header, rows });
  }

  return tables;
}

function cells(row: string): readonly string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function columnIndexes(header: string, names: readonly string[]): readonly number[] {
  const found: number[] = [];
  cells(header).forEach((cell, index) => {
    const normalised = cell.toLowerCase();
    if (names.some((name) => normalised === name || normalised.endsWith(` ${name}`))) {
      found.push(index);
    }
  });
  return found;
}

const files = reportFiles();
const tables = files.flatMap((file) => tablesIn(file));

describe('the committed reports are real tables', () => {
  it('finds the reports it is meant to be checking', () => {
    // A sweep that silently found nothing would pass forever. Both rating
    // artefacts this story publishes are named, so renaming one without
    // updating this file is a failure rather than a quiet gap.
    expect(files).toContain('baseline-ratings.md');
    expect(files).toContain('skill-separation-gate.md');
    expect(tables.length).toBeGreaterThan(3);
  });

  it('finds a behavioural table to check, so the not-reported sweep is not vacuous', () => {
    // Story 7-3's check below inspects `Reasoning share` cells. If no committed
    // report has that column, the check passes while testing nothing -- which
    // is the failure mode this whole file exists to avoid.
    const behavioural = tables.filter((table) =>
      cells(table.header).some((cell) => cell.toLowerCase() === 'reasoning share'),
    );
    expect(behavioural.length).toBeGreaterThan(0);
    expect(behavioural.some((table) => table.rows.length > 0)).toBe(true);
  });
});

describe('no raw win table is published without confidence intervals (AC1)', () => {
  it('gives every table that offers a rate an interval column too', () => {
    const offences: string[] = [];
    for (const table of tables) {
      if (columnIndexes(table.header, RATE_COLUMNS).length === 0) {
        continue;
      }
      if (columnIndexes(table.header, INTERVAL_COLUMNS).length === 0) {
        offences.push(`${table.file}:${String(table.line)}: ${table.header}`);
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('fills the interval cell of every row of every such table', () => {
    // A CI column that exists and is empty is the same publication defect
    // wearing a header.
    const offences: string[] = [];
    for (const table of tables) {
      const rateColumns = columnIndexes(table.header, RATE_COLUMNS);
      const intervalColumns = columnIndexes(table.header, INTERVAL_COLUMNS);
      if (rateColumns.length === 0 || intervalColumns.length === 0) {
        continue;
      }
      for (const row of table.rows) {
        const values = cells(row);
        for (const column of intervalColumns) {
          const value = values[column] ?? '';
          // Two bounds, an en dash between them, four decimal places each --
          // the form `formatBasisPoints` produces and the only one any report
          // in this repo publishes.
          if (!/^\d+\.\d{4} – \d+\.\d{4}$/.test(value)) {
            offences.push(`${table.file}: "${value}" in ${row}`);
          }
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('never publishes a not-reported quantity as a zero (Story 7-3, AC3, INV-5)', () => {
    // The one distinction the behavioural metrics exist to hold: a provider
    // that never reported a quantity and one that reported zero of it are
    // different findings. A type keeps them apart up to the renderer; only a
    // sweep of the committed bytes keeps them apart in what a reader sees.
    //
    // Every column below is nullable at source. A cell in one is either a rate
    // rendered to four places, an integer count, or the words -- and never a
    // bare `0`, which is what a `?? 0` slipped into the renderer would produce.
    // Rate-shaped columns are the ones that matter most: `0` and `0.0000` look
    // alike to a skim-reader, so a rate cell may only ever be four decimal
    // places or the words. A count column legitimately prints `0`.
    const nullableRates: readonly string[] = ['reasoning share', 'bank exhausted'];
    const nullableCounts: readonly string[] = ['tokens / match'];
    /** A rate carrying the counts it came from, e.g. `0.5000 (1 of 2)`. */
    const nullableCountedRates: readonly string[] = ['parse failures', 'rate-limited'];
    const offences: string[] = [];

    for (const table of tables) {
      const rates: number[] = [];
      const counts: number[] = [];
      const countedRates: number[] = [];
      cells(table.header).forEach((cell, index) => {
        const normalised = cell.toLowerCase();
        if (nullableRates.includes(normalised)) {
          rates.push(index);
        }
        if (nullableCounts.includes(normalised)) {
          counts.push(index);
        }
        if (nullableCountedRates.includes(normalised)) {
          countedRates.push(index);
        }
      });

      const check = (column: number, pattern: RegExp, kind: string): void => {
        for (const row of table.rows) {
          const value = (cells(row)[column] ?? '').trim();
          if (value !== 'not reported' && !pattern.test(value)) {
            offences.push(`${table.file}: ${kind} "${value}" in ${row}`);
          }
        }
      };

      for (const column of rates) {
        check(column, /^\d+\.\d{4}$/, 'rate');
      }
      for (const column of counts) {
        check(column, /^\d+$/, 'count');
      }
      for (const column of countedRates) {
        check(column, /^\d+\.\d{4} \(\d+ of \d+\)$/, 'counted rate');
      }
    }

    expect(offences).toStrictEqual([]);
  });

  it('never publishes a rate as a bare fraction that hides its precision', () => {
    // Every rate in this repo is rendered from integer basis points to four
    // places. `0.93` in a report means somebody formatted a float somewhere.
    const offences: string[] = [];
    for (const table of tables) {
      for (const column of columnIndexes(table.header, RATE_COLUMNS)) {
        for (const row of table.rows) {
          const value = cells(row)[column] ?? '';
          if (/^\d+\.\d+$/.test(value) && !/^\d+\.\d{4}$/.test(value)) {
            offences.push(`${table.file}: "${value}" in ${row}`);
          }
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});
