// js/data.js - FIGHTERS + STAGES static data for NextGen AI Arena.
// Pure data module. No DOM, no side effects. All positional/size values are
// FP-scaled integers (FP=1000 => 1 world unit = 1000). World is 1920x1080,
// floor y = 880*FP. Consumed by js/core.js (sim) and render/UI layers.
//
// Hitbox rect convention {ox,oy,w,h} (all FP ints), relative to a fighter whose
// x = body centre and y = feet (bottom):
//   ox = forward offset from centre to the box's REAR edge (facing direction)
//   oy = height of the box's BOTTOM edge above the feet (positive = up)
//   w,h = box size.
// core.js mirrors ox for a left-facing fighter.

const box = (ox, oy, w, h) => ({ ox, oy, w, h });

// Build the shared normal-attack table for a fighter from a few personality
// knobs. reach scales melee width; ldmg/hdmg are Light/Heavy base damage.
function mkMoves(o) {
  const r = o.reach;
  const rw = (base) => Math.round(base * r / 1000); // r is per-mille
  return {
    light: {
      startup: o.lStart, active: 3, recovery: o.lRec, damage: o.ldmg, meterGain: 8,
      hitstun: 15, blockstun: 9, pushback: 14000, guard: 'mid',
      hitbox: box(36000, 168000, rw(96000), 96000),
    },
    heavy: {
      startup: o.hStart, active: 4, recovery: o.hRec, damage: o.hdmg, meterGain: 8,
      hitstun: 21, blockstun: 13, pushback: 30000, guard: 'mid',
      hitbox: box(46000, 128000, rw(142000), 152000),
    },
    // Crouching light = low poke (must be crouch-blocked).
    cLight: {
      startup: o.lStart + 1, active: 3, recovery: o.lRec + 1, damage: o.ldmg - 6, meterGain: 8,
      hitstun: 14, blockstun: 9, pushback: 11000, guard: 'low',
      hitbox: box(36000, 52000, rw(104000), 66000),
    },
  };
}

// Special constructors. kind drives behaviour in core.js.
const projSpecial = (o) => ({
  name: o.name, kind: 'projectile',
  startup: o.startup, active: 6, recovery: o.recovery, damage: o.damage,
  meterGain: 6, guard: 'mid', speed: o.speed, projTtl: o.projTtl,
  projW: 72000, projH: 92000, projYOff: 182000,
});
const dashSpecial = (o) => ({
  name: o.name, kind: 'dash',
  startup: o.startup, active: o.active, recovery: o.recovery, damage: o.damage,
  meterGain: 6, guard: 'mid', dash: o.dash, launch: !!o.launch,
  hitbox: box(30000, 150000, 150000, 170000),
});
const antiAir = (o) => ({
  name: o.name, kind: 'antiair',
  startup: 4, active: 8, recovery: 24, damage: o.damage,
  meterGain: 6, guard: 'mid', rise: o.rise, invuln: 6, launch: true,
  hitbox: box(20000, 120000, 130000, 240000),
});
const superMove = (o) => ({
  name: o.name, kind: o.kind || 'super',
  startup: 8, active: 10, recovery: 26, damage: 280, meterGain: 0,
  guard: 'mid', launch: true, invuln: 12,
  hitbox: box(24000, 44000, 540000, 380000),
  speed: o.speed || 16000, projTtl: 150, projW: 120000, projH: 200000, projYOff: 190000,
});

// v2.0 transformation forms. Permille (x1000) multipliers, PRE-COMPUTED and
// cumulative so the sim does pure integer math (no floats). Each next form:
// +100 dmg, +50 spd, +50 meter. name is a STRING KEY resolved by the UI layer.
function buildForms(id, keys, brandHex, finalAura) {
  const forms = [];
  for (let n = 0; n < keys.length; n++) {
    forms.push({
      key: keys[n],
      name: 'form_' + id + '_' + n,
      auraHex: (n === keys.length - 1 && finalAura) ? finalAura : brandHex,
      dmgPm: 1000 + n * 100,
      spdPm: 1000 + n * 50,
      meterPm: 1000 + n * 50,
    });
  }
  return forms;
}

export const FIGHTERS = {
  clawde: {
    name: 'Clawde', brandHex: '#D97706', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 4500, jumpVel: 22000, hw: 62000, height: 330000, crouchHeight: 205000,
    throwRange: 128000, throwDamage: 120,
    moves: mkMoves({ reach: 1000, ldmg: 50, hdmg: 90, lStart: 4, lRec: 7, hStart: 9, hRec: 16 }),
    targetCombos: [['L', 'L', 'H'], ['L', 'H', 'S']],
    specials: {
      down: dashSpecial({ name: 'roll_strike', startup: 8, active: 6, recovery: 18, damage: 110, dash: 96000 }),
      fwd: projSpecial({ name: 'sunbolt', startup: 12, recovery: 22, damage: 130, speed: 12000, projTtl: 120 }),
      up: antiAir({ name: 'rising_spiral', damage: 130, rise: 20000 }),
    },
    super: superMove({ name: 'sunburst_spiral', kind: 'super' }),
    ability: { name: 'constitution', kind: 'parry', dur: 60, reduceMille: 500, cd: 30 },
    winQuote: 'wq_clawde',
  },
  chatty: {
    name: 'Chatty', brandHex: '#10A37F', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 5600, jumpVel: 21000, hw: 52000, height: 318000, crouchHeight: 198000,
    throwRange: 118000, throwDamage: 100,
    moves: mkMoves({ reach: 850, ldmg: 45, hdmg: 80, lStart: 3, lRec: 6, hStart: 8, hRec: 15 }),
    targetCombos: [['L', 'L', 'L', 'H'], ['L', 'L', 'S']],
    specials: {
      down: dashSpecial({ name: 'token_dash', startup: 6, active: 6, recovery: 16, damage: 95, dash: 120000 }),
      fwd: projSpecial({ name: 'byte_shot', startup: 9, recovery: 18, damage: 110, speed: 15000, projTtl: 110 }),
      up: antiAir({ name: 'stack_rise', damage: 115, rise: 19000 }),
    },
    super: superMove({ name: 'total_generation', kind: 'super' }),
    ability: { name: 'token_stream', kind: 'flurry', shots: 5, interval: 4, dmg: 22, speed: 14000, cd: 45 },
    winQuote: 'wq_chatty',
  },
  gemini: {
    name: 'Gemini', brandHex: '#4285F4', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 4800, jumpVel: 23000, hw: 58000, height: 328000, crouchHeight: 204000,
    throwRange: 124000, throwDamage: 110,
    moves: mkMoves({ reach: 980, ldmg: 48, hdmg: 88, lStart: 4, lRec: 7, hStart: 9, hRec: 16 }),
    targetCombos: [['L', 'H', 'S'], ['L', 'L', 'H']],
    specials: {
      down: dashSpecial({ name: 'phase_kick', startup: 7, active: 6, recovery: 17, damage: 105, dash: 104000 }),
      fwd: projSpecial({ name: 'star_bolt', startup: 11, recovery: 20, damage: 120, speed: 13000, projTtl: 120 }),
      up: antiAir({ name: 'nova_rise', damage: 122, rise: 21000 }),
    },
    super: superMove({ name: 'binary_star', kind: 'super' }),
    ability: { name: 'twin_swap', kind: 'teleport', offset: 130000, cd: 60 },
    winQuote: 'wq_gemini',
  },
  grokk: {
    name: 'Grokk', brandHex: '#111827', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 3300, jumpVel: 19000, hw: 80000, height: 360000, crouchHeight: 224000,
    throwRange: 158000, throwDamage: 150,
    moves: mkMoves({ reach: 800, ldmg: 60, hdmg: 110, lStart: 5, lRec: 9, hStart: 11, hRec: 19 }),
    targetCombos: [['L', 'H'], ['H', 'S']],
    specials: {
      down: dashSpecial({ name: 'quake_slam', startup: 10, active: 6, recovery: 22, damage: 130, dash: 60000 }),
      fwd: dashSpecial({ name: 'chaos_lunge', startup: 9, active: 8, recovery: 20, damage: 140, dash: 150000, launch: true }),
      up: antiAir({ name: 'spin_cyclone', damage: 135, rise: 18000 }),
    },
    super: superMove({ name: 'event_horizon', kind: 'super' }),
    ability: { name: 'chaos_roulette', kind: 'cmdthrow', min: 80, max: 240, range: 150000, cd: 40 },
    winQuote: 'wq_grokk',
  },
  pilot: {
    name: 'Pilot', brandHex: '#6E40C9', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 4300, jumpVel: 21500, hw: 60000, height: 326000, crouchHeight: 203000,
    throwRange: 124000, throwDamage: 112,
    moves: mkMoves({ reach: 1000, ldmg: 50, hdmg: 90, lStart: 4, lRec: 7, hStart: 9, hRec: 16 }),
    targetCombos: [['L', 'L', 'H'], ['L', 'S']],
    specials: {
      down: dashSpecial({ name: 'commit_kick', startup: 8, active: 6, recovery: 18, damage: 108, dash: 92000 }),
      fwd: projSpecial({ name: 'merge_bolt', startup: 12, recovery: 22, damage: 118, speed: 12500, projTtl: 118 }),
      up: antiAir({ name: 'deploy_rise', damage: 126, rise: 20500 }),
    },
    super: superMove({ name: 'ship_it', kind: 'super' }),
    ability: { name: 'autocomplete', kind: 'autoparry', window: 12, counterDmg: 120, cd: 40 },
    winQuote: 'wq_pilot',
  },
  seeker: {
    name: 'Seeker', brandHex: '#0EA5E9', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 4100, jumpVel: 20500, hw: 60000, height: 324000, crouchHeight: 202000,
    throwRange: 122000, throwDamage: 110,
    moves: mkMoves({ reach: 1050, ldmg: 49, hdmg: 92, lStart: 4, lRec: 8, hStart: 10, hRec: 16 }),
    targetCombos: [['L', 'H', 'S'], ['L', 'L', 'H']],
    specials: {
      down: dashSpecial({ name: 'low_slide', startup: 6, active: 10, recovery: 16, damage: 100, dash: 150000 }),
      fwd: projSpecial({ name: 'query_beam', startup: 11, recovery: 20, damage: 122, speed: 14000, projTtl: 130 }),
      up: antiAir({ name: 'ascend', damage: 124, rise: 20000 }),
    },
    super: superMove({ name: 'abyssal_surge', kind: 'super' }),
    ability: { name: 'deep_dive', kind: 'slide', dist: 170000, dur: 24, dmg: 70, guard: 'low', cd: 40 },
    winQuote: 'wq_seeker',
  },
  lama: {
    name: 'Lama', brandHex: '#7C3AED', statMult: 1.0, meterGainMult: 1.0,
    walkSpeed: 4400, jumpVel: 21500, hw: 64000, height: 334000, crouchHeight: 208000,
    throwRange: 130000, throwDamage: 114,
    moves: mkMoves({ reach: 1250, ldmg: 50, hdmg: 94, lStart: 5, lRec: 8, hStart: 10, hRec: 17 }),
    targetCombos: [['L', 'H', 'S'], ['L', 'L', 'H']],
    specials: {
      down: dashSpecial({ name: 'weight_drop', startup: 9, active: 6, recovery: 19, damage: 112, dash: 70000 }),
      fwd: projSpecial({ name: 'open_bolt', startup: 12, recovery: 21, damage: 118, speed: 12000, projTtl: 125 }),
      up: antiAir({ name: 'herd_rise', damage: 124, rise: 20500 }),
    },
    super: superMove({ name: 'herd_release', kind: 'super' }),
    ability: { name: 'open_weights', kind: 'summon', count: 2, dmg: 42, ttl: 90, speed: 11000, cd: 60 },
    winQuote: 'wq_lama',
  },
  edison: {
    // META BOSS: statMult 1.25 (hp + damage), meter gain 1.5x. Deliberately OP.
    name: 'Edison', brandHex: '#16C7E4', statMult: 1.25, meterGainMult: 1.5,
    walkSpeed: 4700, jumpVel: 22500, hw: 64000, height: 340000, crouchHeight: 212000,
    throwRange: 134000, throwDamage: 130,
    moves: mkMoves({ reach: 1100, ldmg: 55, hdmg: 100, lStart: 4, lRec: 7, hStart: 9, hRec: 15 }),
    targetCombos: [['L', 'L', 'H', 'S'], ['L', 'H', 'S']],
    specials: {
      down: dashSpecial({ name: 'insight_strike', startup: 7, active: 6, recovery: 16, damage: 120, dash: 110000 }),
      fwd: projSpecial({ name: 'prompt_bolt', startup: 10, recovery: 18, damage: 160, speed: 14000, projTtl: 130 }),
      up: antiAir({ name: 'masterclass_rise', damage: 140, rise: 22000 }),
    },
    super: superMove({ name: 'nextgen_masterclass', kind: 'super' }),
    ability: { name: 'prompt_engineering', kind: 'summon', count: 2, dmg: 60, ttl: 100, speed: 12000, cd: 55 },
    winQuote: 'wq_edison',
  },
};

// ---- v2.0 forms + hand-anchor post-pass -----------------------------------
// Forms: 7 fighters x 4, edison x 2. Final-form aura overrides: clawde 'fable'
// = blue god; edison 'ultrainstinct' = silver-white (bigger stat jump).
const FORM_KEYS = {
  clawde: ['haiku', 'sonnet', 'opus', 'fable'],
  chatty: ['mini', '4o', 'o3', 'gpt5'],
  gemini: ['flash', 'pro', 'ultra', 'deepthink'],
  grokk: ['grok2', 'grok3', 'grok4', 'heavy'],
  pilot: ['free', 'pro', 'proplus', 'agent'],
  seeker: ['chat', 'v3', 'r1', 'r2'],
  lama: ['scout', 'maverick', 'behemoth', 'finalform'],
};
const FORM_FINAL_AURA = { clawde: '#4FC3F7' };
for (const id in FORM_KEYS) {
  FIGHTERS[id].forms = buildForms(id, FORM_KEYS[id], FIGHTERS[id].brandHex, FORM_FINAL_AURA[id]);
}
FIGHTERS.edison.forms = [
  { key: 'base', name: 'form_edison_0', auraHex: FIGHTERS.edison.brandHex, dmgPm: 1000, spdPm: 1000, meterPm: 1000 },
  { key: 'ultrainstinct', name: 'form_edison_1', auraHex: '#E8F4FF', dmgPm: 1250, spdPm: 1250, meterPm: 1250 },
];

// ---- v2.1 auto-combos + BLAST specials ------------------------------------
// AUTO-COMBOS (contracts.md v2.1): repeated LIGHT chains comboLight[] (jab ->
// straight -> hook -> launcher-finisher); repeated HEAVY chains comboHeavy[]
// (body -> knee -> smash-knockdown). core.js moveData() indexes these by
// f.comboStage; startCombo()/advanceCombo() walk them; the FINAL comboLight
// stage LAUNCHES (launch:true) and the FINAL comboHeavy stage KNOCKS DOWN
// (knockdown:true). Each entry carries the same frame-data shape core reads off
// a melee move: startup/active/recovery/damage/meterGain/hitstun/blockstun/
// pushback/guard/hitbox + launch/knockdown/rise flags. Values vary per fighter
// (damage/speed/reach) to keep each identity; all ints (FP where positional).
//
// BLAST verb (circle): core calls startSpecial(f,'blast') on neutral circle and
// startSpecial(f,'blastHeavy') on fwd+circle - both ki projectiles from the hand
// anchor. up+circle reuses the existing 'up' anti-air special; down+circle is the
// signature ability (F.ability, unchanged). 'down'/'fwd' remain for compat.
const cm = (startup, active, recovery, damage, opts) => {
  opts = opts || {};
  return {
    startup, active, recovery, damage,
    meterGain: opts.meterGain || 8,
    hitstun: opts.hitstun || 16,
    blockstun: opts.blockstun || 10,
    pushback: opts.pushback || 14000,
    guard: opts.guard || 'mid',
    hitbox: box(opts.ox || 40000, opts.oy || 155000, opts.w || 100000, opts.h || 108000),
    launch: !!opts.launch,
    knockdown: !!opts.knockdown,
    rise: opts.rise || 0,
  };
};

// LIGHT auto-chain. First stages share the fighter's jab damage (deliberately
// flat so the sim's combo-damage scaling is what varies late hits); the final
// stage is the launcher finisher (launch:true, a touch more damage + reach).
function buildLight(o) {
  const arr = [
    cm(o.s0, 3, o.r0, o.ld, { w: o.w0, oy: 162000, h: 98000, pushback: 12000, hitstun: 14, blockstun: 9 }),
    cm(o.s0 + 1, 3, o.r0 + 1, o.ld, { w: o.w0, oy: 160000, h: 100000, pushback: 13000, hitstun: 15, blockstun: 9 }),
  ];
  if (o.stages >= 4) {
    arr.push(cm(o.s0 + 2, 3, o.r0 + 2, o.ld, { w: o.w1, oy: 156000, h: 104000, pushback: 15000, hitstun: 16, blockstun: 10 }));
  }
  arr.push(cm(o.sF, 4, o.rF, o.ldF, { launch: true, rise: o.rise, hitstun: 20, blockstun: 12, pushback: 21000, w: o.wF, oy: 138000, h: 152000 }));
  return arr;
}

// HEAVY auto-chain: body -> knee -> smash. Final stage knocks the opponent down.
function buildHeavy(o) {
  return [
    cm(o.s0, 4, o.r0, o.hd0, { pushback: 24000, w: o.w0, oy: 132000, h: 150000, hitstun: 20, blockstun: 12 }),
    cm(o.s0 + 2, 4, o.r0 + 2, o.hd1, { pushback: 27000, w: o.w0 + 12000, oy: 128000, h: 152000, hitstun: 22, blockstun: 13 }),
    cm(o.sF, 5, o.rF, o.hd2, { knockdown: true, rise: 22000, hitstun: 27, blockstun: 15, pushback: 36000, w: o.wF, oy: 120000, h: 162000 }),
  ];
}

// Per-fighter knobs. L = light chain, H = heavy chain, blast/blastHeavy = the two
// BLAST projectiles (projSpecial shape). clawde.blast.damage stays 130 (=old
// sunbolt) so the blocked-special chip test matches. edison numbers are the
// highest (meta boss, further scaled x1.25 by the sim statMille).
const V21 = {
  clawde: {
    L: { ld: 50, ldF: 58, stages: 4, s0: 4, r0: 7, sF: 9, rF: 16, rise: 19000, w0: 100000, w1: 110000, wF: 122000 },
    H: { hd0: 90, hd1: 102, hd2: 120, s0: 9, r0: 14, sF: 14, rF: 20, w0: 120000, wF: 142000 },
    blast: { name: 'sun_blast', startup: 12, recovery: 22, damage: 130, speed: 12000, projTtl: 120 },
    blastHeavy: { name: 'sun_nova', startup: 16, recovery: 26, damage: 172, speed: 10000, projTtl: 120 },
  },
  chatty: {
    L: { ld: 44, ldF: 54, stages: 4, s0: 3, r0: 6, sF: 8, rF: 14, rise: 18000, w0: 86000, w1: 90000, wF: 104000 },
    H: { hd0: 78, hd1: 90, hd2: 108, s0: 8, r0: 14, sF: 13, rF: 19, w0: 104000, wF: 120000 },
    blast: { name: 'byte_blast', startup: 9, recovery: 18, damage: 110, speed: 15000, projTtl: 110 },
    blastHeavy: { name: 'mega_byte', startup: 13, recovery: 23, damage: 150, speed: 12000, projTtl: 110 },
  },
  gemini: {
    L: { ld: 48, ldF: 56, stages: 3, s0: 4, r0: 7, sF: 9, rF: 16, rise: 20000, w0: 96000, w1: 98000, wF: 110000 },
    H: { hd0: 88, hd1: 100, hd2: 118, s0: 9, r0: 14, sF: 14, rF: 20, w0: 116000, wF: 136000 },
    blast: { name: 'star_blast', startup: 11, recovery: 20, damage: 120, speed: 13000, projTtl: 120 },
    blastHeavy: { name: 'nova_blast', startup: 15, recovery: 25, damage: 162, speed: 11000, projTtl: 120 },
  },
  grokk: {
    L: { ld: 60, ldF: 72, stages: 3, s0: 5, r0: 9, sF: 11, rF: 19, rise: 17000, w0: 92000, w1: 94000, wF: 110000 },
    H: { hd0: 110, hd1: 124, hd2: 146, s0: 11, r0: 16, sF: 16, rF: 22, w0: 112000, wF: 132000 },
    blast: { name: 'chaos_orb', startup: 14, recovery: 24, damage: 126, speed: 9000, projTtl: 120 },
    blastHeavy: { name: 'entropy_orb', startup: 18, recovery: 28, damage: 176, speed: 7500, projTtl: 120 },
  },
  pilot: {
    L: { ld: 50, ldF: 58, stages: 4, s0: 4, r0: 7, sF: 9, rF: 16, rise: 20000, w0: 100000, w1: 108000, wF: 120000 },
    H: { hd0: 90, hd1: 102, hd2: 120, s0: 9, r0: 15, sF: 14, rF: 20, w0: 120000, wF: 140000 },
    blast: { name: 'merge_blast', startup: 12, recovery: 22, damage: 118, speed: 12500, projTtl: 118 },
    blastHeavy: { name: 'deploy_blast', startup: 16, recovery: 26, damage: 158, speed: 10500, projTtl: 118 },
  },
  seeker: {
    L: { ld: 49, ldF: 57, stages: 3, s0: 4, r0: 8, sF: 10, rF: 16, rise: 20000, w0: 104000, w1: 106000, wF: 118000 },
    H: { hd0: 92, hd1: 104, hd2: 122, s0: 10, r0: 15, sF: 15, rF: 20, w0: 120000, wF: 142000 },
    blast: { name: 'query_blast', startup: 11, recovery: 20, damage: 122, speed: 14000, projTtl: 130 },
    blastHeavy: { name: 'deep_blast', startup: 15, recovery: 25, damage: 160, speed: 11500, projTtl: 130 },
  },
  lama: {
    L: { ld: 50, ldF: 60, stages: 3, s0: 5, r0: 8, sF: 10, rF: 17, rise: 20000, w0: 120000, w1: 124000, wF: 140000 },
    H: { hd0: 94, hd1: 106, hd2: 126, s0: 10, r0: 16, sF: 15, rF: 21, w0: 134000, wF: 158000 },
    blast: { name: 'open_blast', startup: 12, recovery: 21, damage: 118, speed: 12000, projTtl: 125 },
    blastHeavy: { name: 'weight_blast', startup: 16, recovery: 26, damage: 160, speed: 10000, projTtl: 125 },
  },
  edison: {
    L: { ld: 55, ldF: 66, stages: 4, s0: 4, r0: 7, sF: 9, rF: 15, rise: 22000, w0: 108000, w1: 116000, wF: 128000 },
    H: { hd0: 100, hd1: 114, hd2: 136, s0: 9, r0: 14, sF: 14, rF: 19, w0: 124000, wF: 146000 },
    blast: { name: 'prompt_blast', startup: 10, recovery: 18, damage: 160, speed: 14000, projTtl: 130 },
    blastHeavy: { name: 'insight_blast', startup: 14, recovery: 24, damage: 212, speed: 12000, projTtl: 130 },
  },
};
for (const id in V21) {
  const F = FIGHTERS[id];
  const v = V21[id];
  F.comboLight = buildLight(v.L);
  F.comboHeavy = buildHeavy(v.H);
  F.specials.blast = projSpecial(v.blast);
  F.specials.blastHeavy = projSpecial(v.blastHeavy);
}

// ---- v2.2 per-stage combo poses (render-only annotation) ------------------
// Each comboLight[i]/comboHeavy[i] entry gains a `pose` string the renderer maps
// to a supplemental combo-sheet cell (falling back to a base pose when the _x
// atlas is absent - see the fallback map in js/screens.js). core.js's moveData()
// reads only the frame-data keys and ignores `pose`, so sim state/hash are
// untouched (verified by tools/sim-test.mjs). 4-stage light chains get the extra
// 'c_hook' pose; 3-stage chains skip it; every heavy chain is body/knee/smash.
const COMBO_LIGHT_POSE_4 = ['punchL', 'c_straight', 'c_hook', 'c_launcher'];
const COMBO_LIGHT_POSE_3 = ['punchL', 'c_straight', 'c_launcher'];
const COMBO_HEAVY_POSE = ['c_body', 'c_knee', 'c_smash'];
for (const id in V21) {
  const F = FIGHTERS[id];
  const lp = F.comboLight.length >= 4 ? COMBO_LIGHT_POSE_4 : COMBO_LIGHT_POSE_3;
  for (let i = 0; i < F.comboLight.length; i++) F.comboLight[i].pose = lp[i] || lp[lp.length - 1];
  for (let i = 0; i < F.comboHeavy.length; i++) F.comboHeavy[i].pose = COMBO_HEAVY_POSE[i] || COMBO_HEAVY_POSE[COMBO_HEAVY_POSE.length - 1];
}

// Projectile/beam hand anchors. spawn.dx = forward offset from body front edge;
// spawn.dy = height above feet. v2.3 FIX: the DRAWN sprite fills only ~half of the
// logical F.height (drawn content ~160px vs logical ~330px), so the old height*0.56
// put the blast ABOVE the head. Use ~0.28*height = ~0.56 of the DRAWN body -> the
// standing hand. Edison's ultimate fires from his laptop (lower) at ~0.21*height.
// Covers every projectile special incl. the v2.1 blast/blastHeavy.
for (const id in FIGHTERS) {
  const F = FIGHTERS[id];
  const standDy = Math.round(F.height * 280 / 1000);
  const laptopDy = Math.round(F.height * 210 / 1000);
  for (const key in F.specials) {
    const sp = F.specials[key];
    if (sp && sp.kind === 'projectile') sp.spawn = { dx: 20000, dy: standDy };
  }
  if (F.super) F.super.spawn = { dx: 20000, dy: id === 'edison' ? laptopDy : standDy };
  if (F.ability && F.ability.kind === 'flurry') F.ability.spawn = { dx: 15000, dy: standDy };
}

// ---- v2.2 render-only art facing (FIX C) ----------------------------------
// +1 = the source sprite art is drawn facing RIGHT (the renderer's default
// assumption); -1 = the art is drawn facing LEFT, so drawFighter XORs this into
// its horizontal flip and the fighter still faces the opponent correctly. Verified
// from cell 0 + the attack cells of each `{id}_f0_sheet`: only `lama` (face + punch
// arm point left, tail trails right) is a left-facer; GEMINI too (ponytail trails
// right, punch/walk cue left - confirmed by the v2.3 punch-cell audit). The other
// six face right. PURELY render metadata - core.js never reads it; sim facing stays f.facing.
const ART_FACING = { lama: -1, gemini: -1 };
// Per-(fighter, form) overrides for a single form whose sheet was generated MIRRORED
// relative to the fighter's other forms. lama f3 (Final Form) was drawn facing right
// while lama f0/f1/f2 face left, so it needs the opposite flip to face the opponent.
// Verified in-engine (all 4 forms of every other fighter, incl. gemini, are consistent).
const ART_FACING_FORM = { lama: { 3: 1 } };
for (const id in FIGHTERS) {
  FIGHTERS[id].artFacing = ART_FACING[id] || 1;
  FIGHTERS[id].artFacingForm = ART_FACING_FORM[id] || null;
}

export const STAGES = {
  s1: {
    name: 'Data Dojo', file: './assets/stages/s1.png', npc: './assets/stages/npc1.png',
    npcPlacements: [{ x: 300, y: 760 }, { x: 1600, y: 760 }],
    parallax: [{ layer: 'far', speed: 100 }, { layer: 'mid', speed: 300 }], ambient: 'motes',
  },
  s2: {
    name: 'Neon City', file: './assets/stages/s2.png', npc: './assets/stages/npc2.png',
    npcPlacements: [{ x: 240, y: 800 }, { x: 960, y: 820 }, { x: 1680, y: 800 }],
    parallax: [{ layer: 'far', speed: 80 }, { layer: 'mid', speed: 260 }], ambient: 'rain',
  },
  s3: {
    name: 'KK Waterfront', file: './assets/stages/s3.png', npc: './assets/stages/npc3.png',
    npcPlacements: [{ x: 360, y: 820 }, { x: 1520, y: 820 }],
    parallax: [{ layer: 'far', speed: 60 }, { layer: 'mid', speed: 240 }], ambient: 'motes',
  },
  s4: {
    name: 'Cloud Temple', file: './assets/stages/s4.png', npc: './assets/stages/npc1.png',
    npcPlacements: [{ x: 320, y: 700 }, { x: 1600, y: 700 }],
    parallax: [{ layer: 'far', speed: 120 }, { layer: 'mid', speed: 320 }], ambient: 'clouds',
  },
  s5: {
    name: 'NextGen Lab', file: './assets/stages/s5.png', npc: './assets/stages/npc2.png',
    npcPlacements: [{ x: 260, y: 780 }, { x: 960, y: 800 }, { x: 1660, y: 780 }],
    parallax: [{ layer: 'far', speed: 90 }, { layer: 'mid', speed: 280 }], ambient: 'motes',
  },
  s6: {
    name: 'Circuit Volcano', file: './assets/stages/s6.png', npc: './assets/stages/npc3.png',
    npcPlacements: [{ x: 340, y: 800 }, { x: 1580, y: 800 }],
    parallax: [{ layer: 'far', speed: 110 }, { layer: 'mid', speed: 300 }], ambient: 'embers',
  },
};
