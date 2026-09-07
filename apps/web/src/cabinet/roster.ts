/**
 * The cabinet's roster: the eight fighters a visitor can pick up and play in
 * the embedded arena under `/arena/`. This module is page-side data -- names,
 * lore, asset URLs -- and never touches the simulation. The four ids that the
 * replay engine also knows (`render/roster.ts`) are the same ids, so a Watch
 * stream and a Play session name their fighters the same way.
 *
 * Every string here mirrors the arena's own `strings.js`, so what the gallery
 * says about a fighter is what the cabinet says on its select screen.
 */

export const CABINET_IDS = [
  'clawde',
  'chatty',
  'gemini',
  'grokk',
  'pilot',
  'seeker',
  'lama',
  'edison',
] as const;

export type CabinetId = (typeof CABINET_IDS)[number];

export interface CabinetFighter {
  readonly id: CabinetId;
  /** Display name, as the cabinet prints it. */
  readonly name: string;
  /** Play style, one word. */
  readonly archetype: string;
  /** The transformation ladder, base form first. */
  readonly forms: readonly string[];
  readonly ability: { readonly name: string; readonly description: string };
  readonly super: string;
  /** The win quote the result screen prints. */
  readonly quote: string;
  /** True for the ladder's final boss. */
  readonly boss?: boolean;
}

export const CABINET_ROSTER: Readonly<Record<CabinetId, CabinetFighter>> = Object.freeze({
  clawde: Object.freeze({
    id: 'clawde',
    name: 'Claude',
    archetype: 'Balanced',
    forms: ['Haiku', 'Sonnet', 'Opus', 'Fable'],
    ability: { name: 'Constitution', description: 'Parry stance: 50% damage reduction for 1s, once per round.' },
    super: 'Sunburst Spiral',
    quote: 'Helpful. Honest. Undefeated.',
  }),
  chatty: Object.freeze({
    id: 'chatty',
    name: 'ChatGPT',
    archetype: 'Rushdown',
    forms: ['Mini', 'GPT-4o', 'o3', 'GPT-5'],
    ability: { name: 'Token Stream', description: 'Fires a 5-hit mini projectile flurry.' },
    super: 'Total Generation',
    quote: 'Generating victory.exe... 100% complete.',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    name: 'Gemini',
    archetype: 'Trickster',
    forms: ['Flash', 'Pro', 'Ultra', 'Deep Think'],
    ability: { name: 'Twin Swap', description: 'Afterimage teleport behind the opponent.' },
    super: 'Binary Star',
    quote: 'Multimodal. Multi-talented. You lost in every mode.',
  }),
  grokk: Object.freeze({
    id: 'grokk',
    name: 'Grok',
    archetype: 'Grappler',
    forms: ['Grok 2', 'Grok 3', 'Grok 4', 'Grok Heavy'],
    ability: { name: 'Chaos Roulette', description: 'Command throw: random 80-240 damage.' },
    super: 'Event Horizon',
    quote: 'Real-time chaos. Real-time win.',
  }),
  pilot: Object.freeze({
    id: 'pilot',
    name: 'Copilot',
    archetype: 'Counter',
    forms: ['Free', 'Pro', 'Pro+', 'Agent'],
    ability: { name: 'Autocomplete', description: 'Auto-parry window that counters on hit.' },
    super: 'Ship It',
    quote: 'Shipped. Reviewed. Merged. GG.',
  }),
  seeker: Object.freeze({
    id: 'seeker',
    name: 'DeepSeek',
    archetype: 'Charge',
    forms: ['Chat', 'V3', 'R1', 'R2'],
    ability: { name: 'Deep Dive', description: 'Slides under projectiles with a low hit.' },
    super: 'Abyssal Surge',
    quote: 'Deep research found one thing: your weakness.',
  }),
  lama: Object.freeze({
    id: 'lama',
    name: 'Llama',
    archetype: 'Mid-range',
    forms: ['Scout', 'Maverick', 'Behemoth', 'Final Form'],
    ability: { name: 'Open Weights', description: 'Clone stampede rush-down.' },
    super: 'Herd Release',
    quote: 'Open weights. Closed case.',
  }),
  edison: Object.freeze({
    id: 'edison',
    name: 'Edison',
    archetype: 'Meta boss',
    forms: ['Edison', 'Ultra Instinct'],
    ability: { name: 'Prompt Engineering', description: 'Summons 2 mini-mascots that rush the opponent.' },
    super: 'NextGen Masterclass',
    quote: 'Class dismissed. Lesson: never challenge the trainer.',
    boss: true,
  }),
});

export const CABINET_STAGES: readonly { readonly id: string; readonly name: string }[] = Object.freeze([
  { id: 's1', name: 'Data Dojo' },
  { id: 's2', name: 'Neon City' },
  { id: 's3', name: 'KK Waterfront' },
  { id: 's4', name: 'Cloud Temple' },
  { id: 's5', name: 'NextGen Lab' },
  { id: 's6', name: 'Circuit Volcano' },
]);

export function isCabinetId(value: unknown): value is CabinetId {
  return typeof value === 'string' && (CABINET_IDS as readonly string[]).includes(value);
}

/** The 512x512 select-screen portrait. */
export function cabinetPortraitUrl(id: CabinetId): string {
  return `/arena/assets/portraits/${id}.png`;
}

/** The base-form full-body pose the VS screen uses; transparent background. */
export function cabinetFullUrl(id: CabinetId): string {
  return `/arena/assets/sprites/${id}_f0_full.png`;
}

export function cabinetStageUrl(id: string): string {
  return `/arena/assets/stages/${id}.png`;
}

/** The CSS custom property that carries a fighter's brand colour. */
export function cabinetColourVar(id: CabinetId): string {
  return `var(--tb-fighter-${id})`;
}

export interface CabinetLaunch {
  readonly p1?: CabinetId;
  /** 1 easy, 2 normal, 3 hard. */
  readonly cpu: 1 | 2 | 3;
  /** Best of 1, 3 or 5. */
  readonly rounds: 1 | 3 | 5;
}

export const CABINET_URL = '/arena/index.html';

/** The URL that boots the cabinet straight onto character select. */
export function cabinetLaunchUrl(launch: CabinetLaunch): string {
  const params = new URLSearchParams();
  params.set('mode', 'duel');
  params.set('cpu', String(launch.cpu));
  params.set('rounds', String(launch.rounds));
  if (launch.p1 !== undefined) {
    params.set('p1', launch.p1);
  }
  return `${CABINET_URL}?${params.toString()}`;
}
