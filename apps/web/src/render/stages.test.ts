import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateBackdropLayout } from './backdrop';
import {
  DEFAULT_STAGE,
  STAGE_IDS,
  createStageSelection,
  isStageId,
  stageForSeed,
  stageLayoutUrlFor,
} from './stages';

/**
 * Story 12.10: the stage list, and the three directions that keep it honest.
 *
 * Story 9.7 shipped assets nothing referenced and Story 11.6 found a code path
 * that referenced assets it never drew, so a stage is checked from every side:
 * every stage in the list has a layout, every layer a layout names has a file,
 * and every file under `public/stages` is named by a layout. A stage added and
 * left unwired -- or an image shipped and never drawn -- fails here rather than
 * shipping.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', '..', 'public');
const STAGES_DIR = join(PUBLIC, 'stages');

describe('the stage list', () => {
  it('names six stages, with a deterministic default from the list', () => {
    expect(STAGE_IDS).toHaveLength(6);
    expect(STAGE_IDS).toContain(DEFAULT_STAGE);
  });

  it('derives a stable stage from a seed, so a replay draws the same scene every time', () => {
    // Pure over the seed: the same seed always maps to the same stage, and it
    // stays inside the list for any integer.
    for (const seed of [0, 1, 5, 6, 12, 999, -3]) {
      const first = stageForSeed(seed);
      expect(stageForSeed(seed)).toBe(first);
      expect(STAGE_IDS).toContain(first);
    }
    // Adjacent seeds land on adjacent stages, so the six are actually used.
    expect(stageForSeed(0)).toBe(STAGE_IDS[0]);
    expect(stageForSeed(3)).toBe(STAGE_IDS[3]);
    expect(stageForSeed(6)).toBe(STAGE_IDS[0]);
  });

  it('recognises only ids it shipped', () => {
    expect(isStageId('stage-1')).toBe(true);
    expect(isStageId('stage-9')).toBe(false);
    expect(isStageId(42)).toBe(false);
  });
});

describe('the stage selection', () => {
  it('starts on its initial stage and changes only on a real change', () => {
    const changes: string[] = [];
    const selection = createStageSelection({
      initial: STAGE_IDS[2],
      onChange: (id) => changes.push(id),
    });
    expect(selection.stage()).toBe(STAGE_IDS[2]);
    // A no-op re-pick fires nothing, so re-choosing the shown stage does not
    // re-fetch a megabyte of scenery.
    selection.select(STAGE_IDS[2]);
    expect(changes).toStrictEqual([]);
    selection.select(STAGE_IDS[4]);
    expect(selection.stage()).toBe(STAGE_IDS[4]);
    expect(changes).toStrictEqual([STAGE_IDS[4]]);
  });
});

describe('every stage is wired in all three directions', () => {
  it('has a validatable layout for every id in the list', () => {
    for (const id of STAGE_IDS) {
      const path = join(PUBLIC, stageLayoutUrlFor(id));
      const layout = validateBackdropLayout(JSON.parse(readFileSync(path, 'utf8')));
      // A stage draws depth, so it has at least two layers and they differ in
      // how much of the camera they take -- otherwise there is no parallax.
      expect(layout.layers.length).toBeGreaterThanOrEqual(2);
      const depths = layout.layers.map((layer) => layer.depth);
      expect(new Set(depths).size).toBeGreaterThan(1);
    }
  });

  it('names only files that exist, and every file it ships is named by a layout', () => {
    const namedByLayout = new Set<string>();
    for (const id of STAGE_IDS) {
      const layout = validateBackdropLayout(
        JSON.parse(readFileSync(join(PUBLIC, stageLayoutUrlFor(id)), 'utf8')),
      );
      for (const layer of layout.layers) {
        // Every image a layout names must exist on disk.
        const onDisk = join(PUBLIC, layer.image);
        expect(() => readFileSync(onDisk)).not.toThrow();
        namedByLayout.add(layer.image.replace(/^\//, ''));
      }
    }

    // And the other direction: every PNG shipped under public/stages is drawn by
    // some layout. A scene image left in a directory and never referenced is the
    // Story 9.7 defect, and this is the check that would have caught it.
    const shipped = listPngs(STAGES_DIR).map((abs) =>
      abs.replace(PUBLIC.replace(/\\/g, '/'), '').replace(/^\//, '').replace(/\\/g, '/'),
    );
    for (const file of shipped) {
      expect(namedByLayout).toContain(file);
    }
  });
});

/** Every `.png` under a directory, absolute paths, forward-slashed. */
function listPngs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry).replace(/\\/g, '/');
    if (statSync(abs).isDirectory()) {
      out.push(...listPngs(abs));
    } else if (abs.toLowerCase().endsWith('.png')) {
      out.push(abs);
    }
  }
  return out;
}
