import { escapeHtml } from '../main';
import {
  CABINET_IDS,
  CABINET_ROSTER,
  CABINET_STAGES,
  cabinetColourVar,
  cabinetPortraitUrl,
  cabinetStageUrl,
  type CabinetId,
} from '../cabinet/roster';

/**
 * Fighters: the roster gallery. Every fighter the cabinet ships, with the
 * lore the cabinet's own select screen prints, and one button that drops you
 * into the cabinet already standing on that fighter.
 */

export type SelectEvent = 'click';

export interface SelectNode {
  innerHTML: string;
  addEventListener(type: SelectEvent, listener: () => void): void;
}

export interface SelectHost {
  innerHTML: string;
  querySelector(selectors: string): SelectNode | null;
}

export interface SelectPanelDeps {
  readonly onPlayAs: (id: CabinetId) => void;
}

export interface SelectPanel {
  readonly ids: () => readonly CabinetId[];
}

const PLAY_ATTRIBUTE = 'data-select-play';

function fighterCard(id: CabinetId): string {
  const fighter = CABINET_ROSTER[id];
  const forms = fighter.forms.map((form) => `<li>${escapeHtml(form)}</li>`).join('');
  return `
    <article class="tb-card tb-select-card" style="--tb-card-glow: ${cabinetColourVar(id)}" data-select-card="${id}">
      ${fighter.boss === true ? '<span class="tb-select-badge">Boss</span>' : ''}
      <img class="tb-select-portrait" src="${escapeHtml(cabinetPortraitUrl(id))}" alt="${escapeHtml(fighter.name)} portrait" loading="lazy" />
      <div class="tb-select-body">
        <span class="tb-select-arch">${escapeHtml(fighter.archetype)}</span>
        <h3 class="tb-select-name">${escapeHtml(fighter.name)}</h3>
        <ul class="tb-select-forms" aria-label="Forms">${forms}</ul>
        <p class="tb-select-ability"><strong>${escapeHtml(fighter.ability.name)}.</strong> ${escapeHtml(fighter.ability.description)}</p>
        <p class="tb-select-super">Ultimate · ${escapeHtml(fighter.super)}</p>
        <button class="tb-button tb-select-play" type="button" ${PLAY_ATTRIBUTE}="${id}" aria-label="${escapeHtml(`Play as ${fighter.name}`)}">Play as ${escapeHtml(fighter.name)}</button>
      </div>
    </article>
  `;
}

function stageCard(stage: { readonly id: string; readonly name: string }): string {
  return `
    <div class="tb-card tb-select-stage" data-select-stage="${escapeHtml(stage.id)}">
      <img src="${escapeHtml(cabinetStageUrl(stage.id))}" alt="${escapeHtml(stage.name)}" loading="lazy" />
      <span>${escapeHtml(stage.name)}</span>
    </div>
  `;
}

export function selectMarkup(): string {
  return `
    <span class="tb-eyebrow">Roster · eight fighters</span>
    <h2 class="tb-screen-heading">Fighters</h2>
    <p class="tb-screen-intro">
      Every fighter is a language model with a play style, a transformation ladder that climbs its
      model family, a signature ability and a one-button Ultimate. Pick one to drop straight into the
      cabinet on their card.
    </p>
    <div class="tb-select-grid" role="list">
      ${CABINET_IDS.map((id) => fighterCard(id)).join('')}
    </div>
    <section class="tb-landing-section" aria-label="Arenas">
      <span class="tb-eyebrow">Arenas · six stages</span>
      <h2 class="tb-landing-section-heading">Where you fight</h2>
      <div class="tb-select-stages">${CABINET_STAGES.map((stage) => stageCard(stage)).join('')}</div>
    </section>
  `;
}

export function mountSelectPanel(host: SelectHost, deps: SelectPanelDeps): SelectPanel {
  host.innerHTML = selectMarkup();

  for (const id of CABINET_IDS) {
    const button = host.querySelector(`[${PLAY_ATTRIBUTE}="${id}"]`);
    if (button === null) {
      throw new Error(`mountSelectPanel: the roster did not mount (${id} has no button).`);
    }
    button.addEventListener('click', () => {
      deps.onPlayAs(id);
    });
  }

  return Object.freeze({
    ids: (): readonly CabinetId[] => CABINET_IDS,
  });
}
