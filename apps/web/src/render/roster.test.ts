import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARENA_PALETTE } from './arena-palette';
import {
  DEFAULT_ROSTER,
  ROSTER_IDS,
  ROSTER_NAMES,
  auraFor,
  isRosterId,
  spriteLayoutUrlFor,
  type RosterId,
} from './roster';

/**
 * Story 11.4. The roster is one module so that four facts about a fighter --
 * their sprite pack, their aura, their Ultimate art and their name -- cannot
 * drift apart. So the assertions here are mostly about *agreement* between this
 * module and the tree, rather than about its own arithmetic: a table that only
 * agreed with itself would stay green through exactly the divergence it exists
 * to prevent, which is the Story 9.7 failure in one sentence.
 */

const REPO = join(process.cwd(), '..', '..');

describe('the roster names four fighters and keys everything by them', () => {
  it('holds exactly the four fighters this project shipped art for', () => {
    // An exact list rather than a length, and it is the ratchet: a fifth id
    // added here without art, or an id renamed, has to be a deliberate edit to
    // a test rather than a silent widening.
    expect([...ROSTER_IDS]).toStrictEqual(['clawde', 'chatty', 'gemini', 'grokk']);
  });

  it('gives every fighter an aura that is really in the arena palette', () => {
    for (const id of ROSTER_IDS) {
      expect(auraFor(id)).toBe(ARENA_PALETTE.aura[id]);
      expect(auraFor(id)).toMatch(/^#[0-9a-f]{6}$/);
    }
    // And no two fighters glow alike, which is the whole point of an aura: it
    // answers *whose* Ultimate this is.
    expect(new Set(ROSTER_IDS.map(auraFor)).size).toBe(ROSTER_IDS.length);
  });

  it('points every fighter at a sprite pack that exists on disk', () => {
    // The agreement that matters. `startup.ts` derives its fetch URLs from
    // `spriteLayoutUrlFor`, so a convention that drifted from the tree would
    // 404 both fighters and drop the whole page to the block artist -- with one
    // warning in a console nobody has open.
    for (const id of ROSTER_IDS) {
      const url = spriteLayoutUrlFor(id);
      expect(url).toBe(`/sprites/${id}/layout.json`);
      expect(existsSync(join(REPO, 'apps', 'web', 'public', `sprites/${id}/layout.json`))).toBe(
        true,
      );
    }
  });

  it('ships a portrait for every fighter in the roster', () => {
    for (const id of ROSTER_IDS) {
      expect(existsSync(join(REPO, 'apps', 'web', 'public', 'portraits', `${id}.png`))).toBe(true);
    }
  });

  it('names two of the four as the pair a live Match shows', () => {
    // Two, because a Match has two fighters and character select does not exist
    // yet -- a known gap the epic context records rather than an oversight.
    expect(DEFAULT_ROSTER).toHaveLength(2);
    expect(DEFAULT_ROSTER[0]).not.toBe(DEFAULT_ROSTER[1]);
    for (const id of DEFAULT_ROSTER) {
      expect(ROSTER_IDS).toContain(id);
    }
  });

  it('gives every fighter a display name, and none of them the empty string', () => {
    for (const id of ROSTER_IDS) {
      expect(ROSTER_NAMES[id].length).toBeGreaterThan(0);
      expect(ROSTER_NAMES[id]).toBe(ROSTER_NAMES[id].toUpperCase());
    }
    expect(Object.keys(ROSTER_NAMES).sort()).toStrictEqual([...ROSTER_IDS].sort());
  });

  it('recognises exactly the roster and nothing else', () => {
    for (const id of ROSTER_IDS) {
      expect(isRosterId(id)).toBe(true);
    }
    // The four fighters in the source atlas this project did *not* ship, plus
    // the shapes an untrusted JSON key can actually arrive as.
    for (const other of ['pilot', 'seeker', 'lama', 'edison', '', 'Clawde', 'clawde ']) {
      expect(isRosterId(other)).toBe(false);
    }
    for (const other of [undefined, null, 0, {}, ['clawde'], Symbol('clawde')]) {
      expect(isRosterId(other)).toBe(false);
    }
  });

  it('is frozen, so nothing can rewrite the roster at runtime', () => {
    expect(Object.isFrozen(DEFAULT_ROSTER)).toBe(true);
    expect(Object.isFrozen(ROSTER_NAMES)).toBe(true);
    expect(() => {
      (DEFAULT_ROSTER as unknown as RosterId[])[0] = 'grokk';
    }).toThrow();
  });
});
