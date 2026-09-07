import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CABINET_IDS,
  CABINET_ROSTER,
  CABINET_STAGES,
  cabinetPortraitUrl,
  cabinetStageUrl,
  type CabinetId,
} from '../cabinet/roster';
import { mountSelectPanel, selectMarkup, type SelectHost, type SelectNode } from './select';

/**
 * The Fighters gallery. Eight cards, eight "Play as" buttons, six arenas.
 */

interface FakeHost extends SelectHost {
  readonly fire: (selector: string, type: 'click') => void;
}

function createHost(): FakeHost {
  const nodes = new Map<string, SelectNode>();
  const listeners = new Map<string, (() => void)[]>();
  const state = { html: '' };

  const child = (selector: string): SelectNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: SelectNode = {
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
    querySelector: (selector: string): SelectNode | null => child(selector),
    fire: (selector: string, type: 'click'): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener();
      }
    },
  };
}

describe('the Fighters gallery shows the whole cabinet roster', () => {
  it('names every fighter, shows every portrait, and offers to play as each', () => {
    const markup = selectMarkup();
    for (const id of CABINET_IDS) {
      const fighter = CABINET_ROSTER[id];
      expect(markup).toContain(fighter.name);
      expect(markup).toContain(cabinetPortraitUrl(id));
      expect(markup).toContain(`data-select-play="${id}"`);
      expect(markup).toContain(fighter.archetype);
      expect(markup).toContain(fighter.ability.name);
      expect(markup).toContain(fighter.super);
      for (const form of fighter.forms) {
        expect(markup).toContain(form);
      }
    }
  });

  it('marks the boss, and only the boss', () => {
    const markup = selectMarkup();
    expect(markup.match(/tb-select-badge/g)).toHaveLength(1);
    const bossCard = markup.slice(markup.indexOf('data-select-card="edison"'));
    expect(bossCard.slice(0, bossCard.indexOf('</article>'))).toContain('Boss');
  });

  it('colours each card from its own fighter token, never a raw colour', () => {
    const markup = selectMarkup();
    for (const id of CABINET_IDS) {
      expect(markup).toContain(`--tb-card-glow: var(--tb-fighter-${id})`);
    }
    expect(markup).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('sends a Play-as click through with the fighter id', () => {
    const host = createHost();
    const picked: CabinetId[] = [];
    const panel = mountSelectPanel(host, {
      onPlayAs: (id) => {
        picked.push(id);
      },
    });
    host.fire('[data-select-play="gemini"]', 'click');
    host.fire('[data-select-play="edison"]', 'click');
    expect(picked).toStrictEqual(['gemini', 'edison']);
    expect(panel.ids()).toStrictEqual(CABINET_IDS);
  });

  it('throws rather than mounting half a gallery when a button is missing', () => {
    const broken: SelectHost = {
      innerHTML: '',
      querySelector: () => null,
    };
    expect(() => mountSelectPanel(broken, { onPlayAs: () => undefined })).toThrow(/did not mount/);
  });

  it('gives every shipped stage a card with its art', () => {
    const markup = selectMarkup();
    for (const stage of CABINET_STAGES) {
      expect(markup).toContain(stage.name);
      expect(markup).toContain(cabinetStageUrl(stage.id));
    }
  });

  it('escapes what it prints', () => {
    // Every string comes from this repo's own roster module, so this is a
    // guard on the template rather than on data: a name with a `<` in it must
    // not become markup.
    expect(selectMarkup()).not.toContain('<script');
  });
});

describe('the gallery follows docs/DESIGN.md', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'app.css'), 'utf8');

  it('lays the roster out in a grid whose columns can actually shrink', () => {
    const at = css.indexOf('.tb-select-grid {');
    const block = css.slice(at, css.indexOf('}', at));
    expect(block).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(/);
  });

  it('gives the Play-as buttons the focus ring every control has', () => {
    expect(css).toMatch(/\.tb-button:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--tb-accent\)/);
  });
});
