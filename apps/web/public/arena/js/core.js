// js/core.js - deterministic combat core for NextGen AI Arena.
//
// Contract (design/contracts.md): exports FP, createMatch, stepMatch, hashState,
// serialize, deserialize, cpuInput. Browser ES module; imports ONLY ./data.js;
// NO DOM/window/document; NO Math.random / Date.now anywhere in the sim.
//
// Determinism rules honoured here:
//  - all gameplay values are integers (positions FP-scaled, FP=1000).
//  - the only randomness is a seeded LCG stored in state.rng (uint32).
//  - state is plain JSON: survives JSON.parse(JSON.stringify(s)) with an
//    identical hashState afterward. No functions/Maps/typed-arrays in state.
//  - stepMatch advances exactly one 60Hz tick and returns an events array.
//
// Same seed + same input sequence => identical hashState after N steps. This is
// the lockstep-netplay foundation and the #1 acceptance criterion.

import { FIGHTERS } from './data.js';

export const FP = 1000;

// ---- world constants (FP ints) --------------------------------------------
const FLOOR_Y = 880 * FP;      // feet rest here
const ARENA_MIN = 0;
const ARENA_MAX = 1920 * FP;
const WALLPAD = 90000;         // keep body centre off the walls
const GRAVITY = 1400;          // added to vy each airborne tick
const P1_START = 700000;
const P2_START = 1220000;

const INTRO_TICKS = 90;        // "ROUND N / FIGHT!" pre-roll
const ROUNDEND_TICKS = 120;    // KO / timeout hold before next round
const PROJ_CAP = 16;
const SUMMON_CAP = 8;

// Input bitmask v3 (contracts.md v2.1 addendum). bit6 BLAST (circle) is the old
// SPECIAL bit (64) renamed; bit9 DASH (cross) = 512. All masks read & 0x3FF.
const IN_LEFT = 1, IN_RIGHT = 2, IN_UP = 4, IN_DOWN = 8;
const IN_LIGHT = 16, IN_HEAVY = 32, IN_BLAST = 64, IN_START = 128;
const IN_POWER = 256, IN_DASH = 512;
const IN_MASK = 0x3FF;

// v2 transform tuning.
const KI_STEP = 100;           // ki sub-accumulator added per charge tick
const KI_DEN = 180;            // sub units per 1 ki point => empty->full in 180 ticks (3s)
const KI_MAX = 100;
const TRANSFORM_TICKS = 45;    // transform commitment window
const TRANSFORM_INVULN = 20;   // payoff i-frames on completion
const CINEMATIC_FREEZE = 90;   // ultimate freeze phase (both fighters frozen)

// v2.1 dash tuning (PlayStation cross verb).
const DASH_CD = 24;            // per-fighter dash cooldown
const DASHF_TICKS = 14;        // forward dash length
const DASHB_TICKS = 16;        // back dash length
const DASHB_INVULN = 6;        // back-dash i-frames (frames 1..6)
const DASHF_CANCEL = 4;        // forward dash becomes attack-cancelable after this
const DASHF_SPD = 16000;       // forward dash per-tick velocity
const DASHB_SPD = 12000;       // back dash per-tick velocity

// v2.3 time-limited transforms: a gained form reverts to base after this many
// un-frozen ticks (20s @ 60fps). Player must re-charge ki to transform again.
const FORM_TTL = 1200;

// v2.3 CPU blast throttle: after a CPU-fired ki projectile, do not choose BLAST
// again for this many ticks (kills the old "always blasts" spam).
const AI_BLAST_CD = 48;

// v2.3 ULTIMATE CLASH (button-mash beam duel when two supers collide).
const CLASH_MAX_FRAMES = 300;  // hard cap (5s @ 60fps) before the duel force-resolves
const CLASH_PUSH_MAX = 300000; // FP: push cap (~half the fighters' gap) = instant win
const CLASH_MASH_STEP = 8000;  // FP push added per net mash
const CLASH_ATTACK_BITS = IN_LIGHT | IN_HEAVY | IN_BLAST; // fresh press of any = one mash
// Frames between CPU clash mashes, indexed by difficulty level (1=easy..3=hard) @60fps.
// ~7.5 / 12 / 20 presses per sec: easy = out-mash it by casual tapping, hard = fast drumming.
const CLASH_CPU_PERIOD = [0, 8, 5, 3];

// v2.5 ULTIMATE REACTION WINDOW: after A fires its ultimate, B may answer with its
// OWN ultimate (needs meter>=100) for this many un-frozen ticks to force a CLASH.
// Both fighters are frozen during the window (a dramatic beat), so this is a pure
// reaction budget: ~0.7s @ 60fps, above (human reaction ~15-20t) + (online 3-frame
// delay) + (3-button chord slop). Single tunable constant.
const ULT_CHALLENGE_WINDOW = 42;

// v2.4 MANA (ki blast resource; separate from the ultimate meter).
const MANA_MAX = 100;
const MANA_STEP = 100;         // mana sub-accumulator added per regen tick
const MANA_DEN = 60;            // sub units per 1 mana point => empty->full in 60 ticks (1s)
const MANA_COST_BLAST = 25;     // neutral ki blast cost
const MANA_COST_BLASTHV = 40;   // fwd heavy blast cost

// v2.4 AIR DASH (forward/back, once per jump, free - no mana cost).
const AIRDASH_TICKS = 12;
const AIRDASH_SPD = 20000;

// phase codes (for hashState)
const PHASE_CODE = { intro: 1, fight: 2, roundEnd: 3, over: 4 };
// stateName codes (for hashState)
const STATE_CODE = {
  idle: 0, walk: 1, crouch: 2, jump: 3, block: 4, attackL: 5, attackH: 6,
  special: 7, super: 8, throw: 9, thrown: 10, hitstun: 11, blockstun: 12,
  ko: 13, parry: 14, slide: 15, land: 16, charge: 17, transform: 18,
  dashF: 19, dashB: 20, dashAirF: 21, dashAirB: 22,
};
// moveCat/move/comboKind codes (for hashState; desync audit). These are
// bounded string enums the sim itself assigns (see makeFighter/startCombo/
// startSpecial/startSuper), mapped to small ints the same way stateName is.
// Any value not in the map (there shouldn't be one) falls back to 0 via `|| 0`
// at the call site, same convention as STATE_CODE/PHASE_CODE.
const MOVECAT_CODE = { '': 0, normal: 1, comboL: 2, comboH: 3, special: 4, super: 5 };
const MOVE_CODE = { '': 0, cLight: 1, fwd: 2, up: 3, blastHeavy: 4, blast: 5, super: 6 };
const COMBOKIND_CODE = { '': 0, L: 1, H: 2 };

// ---- seeded RNG (LCG) ------------------------------------------------------
// Numerical Recipes constants; state.rng holds the current uint32.
function nextRng(state) {
  state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
  return state.rng;
}
// Pure, non-mutating 32-bit mixer (used by CPU so cpuInput never mutates state).
function mix32(a) {
  a = a >>> 0;
  a = Math.imul(a ^ (a >>> 16), 2246822519);
  a = Math.imul(a ^ (a >>> 13), 3266489917);
  a = (a ^ (a >>> 16)) >>> 0;
  return a;
}

// ---- construction ----------------------------------------------------------
function makeFighter(fid, x, facing) {
  const F = FIGHTERS[fid];
  const statMille = Math.round(F.statMult * 1000);
  const meterMille = Math.round((F.meterGainMult || 1) * 1000);
  const maxHp = Math.round(5000 * F.statMult); // v2.3: 5x the 1000 baseline - much longer fights per playtest feedback
  return {
    id: fid, x, y: FLOOR_Y, vx: 0, vy: 0,
    hp: maxHp, maxHp, meter: 0, facing,
    stateName: 'idle', stateFrame: 0,
    combo: 0, juggle: 0,
    blocking: false, crouching: false, airborne: false,
    moveCat: '', move: '', hasHit: false, spawned: false,
    hitstun: 0, blockstun: 0,
    chainTtl: 0, specialTtl: 0,
    invulnTtl: 0, projImmuneTtl: 0,
    parryTtl: 0, reduceTtl: 0, autoParryTtl: 0,
    slideTtl: 0, airHurt: false,
    abilityUsedRound: false, abilityCd: 0,
    flurryLeft: 0, flurryTtl: 0,
    throwTarget: 0, throwTimer: 0, beingThrown: false, throwTechTtl: 0,
    tookDamage: false, _throwWhiff: 0,
    statMille, meterMille,
    // v2: transformation + last-input tracking
    form: 0, ki: 0, kiSub: 0, charging: false, transformTtl: 0, _txStart: false,
    inMask: 0, swung: false,
    // v2.1: auto-combo stage + dash
    comboStage: 0, comboKind: '', dashCd: 0, dashTtl: 0,
    // v2.3: time-limited transform countdown + CPU blast cooldown
    formTtl: 0, aiBlastCd: 0,
    // v2.4: mana (ki blast resource) + air dash (once per jump, free)
    mana: MANA_MAX, manaSub: 0, airDashUsed: 0,
  };
}

function makePool(cap, extra) {
  const arr = [];
  for (let i = 0; i < cap; i++) {
    const o = { active: false, owner: 0, x: 0, y: 0, vx: 0, vy: 0, dmg: 0, ttl: 0, w: 0, h: 0, hasHit: false, kind: 0, held: 0 };
    if (extra) for (const k in extra) o[k] = extra[k];
    arr.push(o);
  }
  return arr;
}

export function createMatch(cfg) {
  cfg = cfg || {};
  const p1 = (cfg.p1 && cfg.p1.fighterId) || 'clawde';
  const p2 = (cfg.p2 && cfg.p2.fighterId) || 'chatty';
  const roundsToWin = cfg.roundsToWin === 1 || cfg.roundsToWin === 3 ? cfg.roundsToWin : (cfg.roundsToWin || 2);
  const timerSecs = cfg.timerSecs || 99;
  const seed = (cfg.seed >>> 0) || 0x1a2b3c4d;
  const state = {
    frame: 0,
    roundsToWin,
    round: 1,
    timerSecs,
    timer: timerSecs * 60,
    phase: 'intro',
    phaseTtl: INTRO_TICKS,
    wins: [0, 0],
    winner: 0,
    stageId: cfg.stageId || 's1',
    rng: seed,
    seed,
    freeze: 0, freezeSide: 0,   // v2: ultimate cinematic-freeze window
    // v2.5 ULTIMATE REACTION WINDOW (int; ticks left + initiator side 1|2, 0 = inactive).
    ultChallenge: 0, ultChallengeSide: 0,
    // v2.3 ULTIMATE CLASH state (all int; frozen mash duel between two supers).
    clashActive: 0, clashFrames: 0, clashMash0: 0, clashMash1: 0,
    clashPush: 0, clashWinner: 0, clashMidX: 0, clashPrev0: 0, clashPrev1: 0,
    fighters: [makeFighter(p1, P1_START, 1), makeFighter(p2, P2_START, -1)],
    projectiles: makePool(PROJ_CAP),
    summons: makePool(SUMMON_CAP, { life: 0 }),
    lastEvents: [],
  };
  return state;
}

// ---- helpers ---------------------------------------------------------------
function otherIdx(i) { return i === 0 ? 1 : 0; }

function resetForRound(state) {
  const f0 = state.fighters[0], f1 = state.fighters[1];
  reinitFighter(f0, P1_START, 1);
  reinitFighter(f1, P2_START, -1);
  for (let i = 0; i < state.projectiles.length; i++) state.projectiles[i].active = false;
  for (let i = 0; i < state.summons.length; i++) state.summons[i].active = false;
  state.timer = state.timerSecs * 60;
  state.phase = 'intro';
  state.phaseTtl = INTRO_TICKS;
  state.winner = 0;
  state.freeze = 0; state.freezeSide = 0;
  state.ultChallenge = 0; state.ultChallengeSide = 0;
  state.clashActive = 0; state.clashFrames = 0; state.clashMash0 = 0; state.clashMash1 = 0;
  state.clashPush = 0; state.clashWinner = 0; state.clashMidX = 0; state.clashPrev0 = 0; state.clashPrev1 = 0;
}

function reinitFighter(f, x, facing) {
  const maxHp = f.maxHp;
  f.x = x; f.y = FLOOR_Y; f.vx = 0; f.vy = 0;
  f.hp = maxHp; f.meter = 0; f.facing = facing;
  f.stateName = 'idle'; f.stateFrame = 0;
  f.combo = 0; f.juggle = 0;
  f.blocking = false; f.crouching = false; f.airborne = false;
  f.moveCat = ''; f.move = ''; f.hasHit = false; f.spawned = false;
  f.hitstun = 0; f.blockstun = 0; f.chainTtl = 0; f.specialTtl = 0;
  f.invulnTtl = 0; f.projImmuneTtl = 0; f.parryTtl = 0; f.reduceTtl = 0;
  f.autoParryTtl = 0; f.slideTtl = 0; f.airHurt = false;
  f.abilityUsedRound = false; f.abilityCd = 0;
  f.flurryLeft = 0; f.flurryTtl = 0;
  f.throwTarget = 0; f.throwTimer = 0; f.beingThrown = false; f.throwTechTtl = 0;
  f.tookDamage = false; f._throwWhiff = 0;
  // v2: forms PERSIST across rounds (only createMatch resets them). Ki + the
  // in-progress transform/charge do reset, like meter.
  f.ki = 0; f.kiSub = 0; f.charging = false; f.transformTtl = 0; f._txStart = false;
  f.inMask = 0; f.swung = false;
  f.comboStage = 0; f.comboKind = ''; f.dashCd = 0; f.dashTtl = 0;
  // v2.3: form persists across rounds (see above), but the in-round revert timer
  // and the CPU blast cooldown reset each round.
  f.formTtl = 0; f.aiBlastCd = 0;
  // v2.4: mana starts full each round; air-dash usage resets.
  f.mana = MANA_MAX; f.manaSub = 0; f.airDashUsed = 0;
}

function moveData(f) {
  const F = FIGHTERS[f.id];
  if (f.moveCat === 'normal') return F.moves[f.move];
  if (f.moveCat === 'comboL') return F.comboLight[f.comboStage];
  if (f.moveCat === 'comboH') return F.comboHeavy[f.comboStage];
  if (f.moveCat === 'special') return F.specials[f.move];
  if (f.moveCat === 'super') return F.super;
  return null;
}

// ---- v2 form helpers -------------------------------------------------------
function formsOf(f) { return FIGHTERS[f.id].forms; }
function lastFormIdx(f) { const a = formsOf(f); return a ? a.length - 1 : 0; }
function curForm(f) { const a = formsOf(f); if (!a) return { dmgPm: 1000, spdPm: 1000, meterPm: 1000 }; return a[f.form] || a[a.length - 1]; }
function walkSpeedOf(f) { return Math.floor(FIGHTERS[f.id].walkSpeed * curForm(f).spdPm / 1000); }

// Muzzle / hand anchor for a projectile or beam spawn. spawn = {dx,dy} from data;
// dy defaults to ~56% of the fighter's height (standing hand). Returns world FP.
function spawnAnchor(f, spawn) {
  const F = FIGHTERS[f.id];
  const front = F.hw + ((spawn && spawn.dx) || 20000);
  const dy = (spawn && spawn.dy) || Math.floor(F.height * 560 / 1000);
  return { x: clampX(f.x + f.facing * front), y: f.y - dy };
}

// A fighter is actionable (can start a fresh action) when not stunned/committed.
function isActionable(f) {
  if (f.hitstun > 0 || f.blockstun > 0 || f.beingThrown) return false;
  const s = f.stateName;
  if (s === 'ko' || s === 'thrown' || s === 'hitstun' || s === 'blockstun') return false;
  if (s === 'special' || s === 'super' || s === 'throw' || s === 'slide' || s === 'parry' || s === 'transform') return false;
  if (s === 'dashF' || s === 'dashB') return false; // dash is committed (dashF is attack-cancelable separately)
  if (s === 'attackL' || s === 'attackH') return false; // committed; re-attack only via cancel window
  return true; // idle/walk/crouch/jump/block/land/charge
}

// Body hurtbox (axis-aligned) of a fighter.
function hurtRect(f) {
  const F = FIGHTERS[f.id];
  const h = f.crouching && !f.airborne ? F.crouchHeight : F.height;
  return { x0: f.x - F.hw, x1: f.x + F.hw, y0: f.y - h, y1: f.y };
}

// Active melee hitbox rect for a fighter, or null.
function activeHitRect(f) {
  if (f.hasHit) return null; // one connect per swing
  const mv = moveData(f);
  if (!mv || !mv.hitbox) return null;
  if (f.moveCat === 'special' && mv.kind === 'projectile') return null;
  const s = f.stateFrame;
  if (s < mv.startup || s >= mv.startup + mv.active) return null;
  const b = mv.hitbox;
  if (f.facing > 0) {
    const x0 = f.x + b.ox;
    return { x0, x1: x0 + b.w, y0: f.y - b.oy - b.h, y1: f.y - b.oy };
  }
  const x1 = f.x - b.ox;
  return { x0: x1 - b.w, x1, y0: f.y - b.oy - b.h, y1: f.y - b.oy };
}

function overlaps(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

// Guard height match. holdingDown = defender pressing down this tick (crouch guard).
// low must be crouch-blocked; high/overhead must be stand-blocked; mid either.
function guardOK(guard, holdingDown) {
  if (guard === 'low') return holdingDown;
  if (guard === 'high' || guard === 'overhead') return !holdingDown;
  return true;
}

// v2: blocking is a HIT-TIME decision read from the defender's CURRENT input mask
// (f.inMask). A grounded, non-busy defender who is holding AWAY from the attacker
// blocks; holding down-back additionally blocks lows. There is no standing "block"
// stance any more (holding back walks backward) - the 'block' pose exists only
// during blockstun.
function defenderBlocking(def, atk) {
  if (def.airborne) return false;
  if (def.hitstun > 0 || def.beingThrown) return false;
  const s = def.stateName;
  if (s === 'attackL' || s === 'attackH' || s === 'special' || s === 'super'
    || s === 'throw' || s === 'thrown' || s === 'charge' || s === 'transform'
    || s === 'dashF' || s === 'dashB') return false;
  const awayBit = (def.x <= atk.x) ? IN_LEFT : IN_RIGHT; // press away from attacker
  return (def.inMask & awayBit) !== 0;
}

// ---- input decode notes ----------------------------------------------------
// v2.1 PlayStation verbs. There are NO two-button chords any more (the old
// H+S throw and L+S ability chords are GONE - they used to intercept an
// imperfectly-timed 3-button ULTIMATE press and start a throw/ability instead,
// which is why an ultimate "would not come out"). Decode is now:
//   LIGHT           -> auto-combo (comboLight) / crouch-low if holding down
//   HEAVY           -> auto-combo (comboHeavy); fwd+HEAVY point-blank = throw
//   BLAST (circle)  -> neutral: ki projectile | fwd: heavy blast |
//                      down: signature ability | up: anti-air special
//   DASH  (cross)   -> toward/neutral: forward dash | away: back dash
//   LIGHT+HEAVY+BLAST at meter 100 -> ULTIMATE (only remaining multi-button verb)
// All logic lives inline in stepInput so it can read the opponent position.

// ---- spawn helpers ---------------------------------------------------------
function spawnProjectile(state, owner, x, y, vx, dmg, ttl, w, h, kind) {
  const pool = state.projectiles;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.active) {
      p.active = true; p.owner = owner; p.x = x; p.y = y; p.vx = vx; p.vy = 0;
      p.dmg = dmg; p.ttl = ttl; p.w = w; p.h = h; p.hasHit = false; p.kind = kind; p.held = 0;
      return p;
    }
  }
  return null;
}

function spawnSummon(state, owner, x, facing, dmg, ttl, speed, kind) {
  const pool = state.summons;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (!s.active) {
      s.active = true; s.owner = owner; s.x = x; s.y = FLOOR_Y; s.vx = facing * speed; s.vy = 0;
      s.dmg = dmg; s.ttl = ttl; s.w = 90000; s.h = 260000; s.hasHit = false; s.kind = kind; s.life = 0;
      return s;
    }
  }
  return null;
}

// ---- damage application ----------------------------------------------------
// source: 'melee' | 'projectile' | 'summon' | 'throw'. Returns true on connect.
function applyHit(state, atkIdx, defIdx, mv, source, events) {
  const atk = state.fighters[atkIdx];
  const def = state.fighters[defIdx];
  if (def.stateName === 'ko') return false;
  if (def.invulnTtl > 0) return false;
  if (source === 'projectile' && def.projImmuneTtl > 0) return false;

  // v2: a hit during a transform CANCELS it (form NOT gained, ki halved) then
  // resolves as a normal hit below.
  if (def.stateName === 'transform') { def.transformTtl = 0; def.charging = false; def.ki = def.ki >> 1; }
  if (def.stateName === 'charge') { def.charging = false; }

  const isSpecial = mv.kind === 'projectile' || mv.kind === 'dash' || mv.kind === 'antiair'
    || source === 'projectile' || source === 'summon' || mv.kind === 'super' || mv.kind === 'slide';

  // Pilot Autocomplete auto-parry window: negate + counter.
  if (def.autoParryTtl > 0 && source !== 'throw') {
    def.autoParryTtl = 0;
    atk.hitstun = 24; atk.stateName = 'hitstun'; atk.combo = 0;
    def.meter = clampMeter(def.meter + meterGain(def, 12));
    events.push({ t: 'special', side: defIdx + 1, x: def.x, y: def.y, data: { ability: 'autocomplete' } });
    return true;
  }

  // Blocking (hit-time, read from def.inMask). v2.2: a successful block negates
  // 100% of the damage - NO chip, on normals OR specials (Edison's playtest ask:
  // holding back must take zero damage). Down-back blocks lows; stand-back blocks
  // highs/mids.
  const facingAtk = (def.x <= atk.x) ? 1 : -1; // dir toward attacker
  const holdingDown = (def.inMask & IN_DOWN) !== 0;
  if (source !== 'throw' && defenderBlocking(def, atk) && guardOK(mv.guard, holdingDown)) {
    def.blockstun = mv.blockstun || 12;
    def.stateName = 'block';   // 'block' pose lives ONLY during blockstun
    def.blocking = true;
    def.meter = clampMeter(def.meter + meterGain(def, 4));
    // block pushback (no chip damage - full negation)
    pushback(state, defIdx, atkIdx, Math.floor((mv.pushback || 18000) * 3 / 4), facingAtk);
    events.push({ t: 'block', side: defIdx + 1, x: def.x, y: def.y, data: { chip: 0 } });
    return true;
  }

  // Juggle cap: airborne opponent can only take 3 juggle hits.
  if (def.airborne && def.juggle >= 3) return false;

  // Clawde Constitution: 50% reduction window.
  let dmg = scaledDamage(atk, mv.damage, def);
  if (def.reduceTtl > 0) dmg = Math.floor(dmg * 500 / 1000);
  if (dmg < 1) dmg = 1;

  def.hp -= dmg; if (def.hp < 0) def.hp = 0;
  def.tookDamage = true;
  def.blocking = false;

  // stun + launch / knockdown. A knockdown smash (heavy combo finisher) sends
  // the defender off their feet with a harder pop + longer stun.
  const knockdown = !!mv.knockdown;
  const launch = mv.launch || knockdown || def.airborne;
  if (launch) {
    def.airborne = true; def.airHurt = true;
    const rise = mv.rise ? Math.floor(mv.rise * 3 / 4) : (knockdown ? 20000 : 16000);
    def.vy = -rise;
    def.juggle += 1;
    def.hitstun = Math.max(mv.hitstun || 18, knockdown ? 26 : 16);
    def.stateName = 'hitstun';
  } else {
    def.hitstun = mv.hitstun || 16;
    def.stateName = 'hitstun';
  }
  // cancel any committed defender move
  def.moveCat = ''; def.move = '';

  pushback(state, defIdx, atkIdx, mv.pushback || 18000, facingAtk);

  // meter + combo bookkeeping
  atk.meter = clampMeter(atk.meter + meterGain(atk, mv.meterGain || 8));
  def.meter = clampMeter(def.meter + meterGain(def, 6));
  atk.combo += 1;
  if (source === 'melee') { atk.chainTtl = 12; atk.specialTtl = 10; }

  events.push({ t: 'hit', side: atkIdx + 1, x: def.x, y: def.y - 160000, data: { dmg, combo: atk.combo, source, kd: knockdown, launch: !!(mv.launch || knockdown) } });
  return true;
}

// Meter gain folds the fighter statline meter multiplier AND the current form's
// meter permille (form 0 = 1000, so no change until transformed).
function meterGain(f, base) { return Math.floor(base * f.meterMille * curForm(f).meterPm / 1000000); }
function clampMeter(m) { return m > 100 ? 100 : (m < 0 ? 0 : m); }

// Damage scaling: hits 4+ scale x0.8 cumulative, floor x0.3. Uses attacker.combo
// (hits already landed this combo). statMult folded in (edison 1.25).
function scaledDamage(atk, base, def) {
  let d = Math.floor(base * atk.statMille / 1000);
  d = Math.floor(d * curForm(atk).dmgPm / 1000); // v2 form damage bonus (form 0 = x1)
  const hitNumber = atk.combo + 1; // this hit
  const extra = hitNumber - 3;
  if (extra > 0) {
    let scale = 1000;
    for (let k = 0; k < extra; k++) scale = Math.floor(scale * 800 / 1000);
    if (scale < 300) scale = 300;
    d = Math.floor(d * scale / 1000);
  }
  return d;
}

function pushback(state, defIdx, atkIdx, mag, dir) {
  const def = state.fighters[defIdx];
  const atk = state.fighters[atkIdx];
  const target = def.x + dir * mag;
  if (target < WALLPAD || target > ARENA_MAX - WALLPAD) {
    // cornered: transfer pushback to the attacker (corner pressure)
    atk.x = clampX(atk.x - dir * mag);
  }
  def.x = clampX(target);
}

function clampX(x) {
  if (x < WALLPAD) return WALLPAD;
  if (x > ARENA_MAX - WALLPAD) return ARENA_MAX - WALLPAD;
  return x;
}

// ---- attack / ability starters --------------------------------------------
// Crouching light = low poke (single hit, must be crouch-blocked). Not part of
// the auto-combo chain.
function startNormalLow(f) {
  f.moveCat = 'normal'; f.move = 'cLight';
  f.stateName = 'attackL';
  f.stateFrame = 0; f.hasHit = false; f.spawned = false; f.swung = false;
  f.vx = 0; f.crouching = false; f.blocking = false;
  f.comboStage = 0; f.comboKind = '';
}

// v2.1 AUTO-COMBO: LIGHT/HEAVY start stage 0 of comboLight/comboHeavy. A fresh
// same-button press inside the chain-cancel window (after the current stage has
// CONNECTED) advances to the next stage; a whiff or the window closing lets the
// stage recover and the chain resets to 0 (handled in stepTimers).
function startCombo(f, kind, events, idx) {
  const isL = kind === 'light';
  f.moveCat = isL ? 'comboL' : 'comboH';
  f.comboKind = isL ? 'L' : 'H';
  f.comboStage = 0;
  f.stateName = isL ? 'attackL' : 'attackH';
  f.stateFrame = 0; f.hasHit = false; f.spawned = false; f.swung = false;
  f.vx = 0; f.crouching = false; f.blocking = false;
  events.push({ t: 'comboStage', side: idx + 1, stage: 0 });
}

function advanceCombo(f, events, idx) {
  f.comboStage += 1;
  f.stateName = f.moveCat === 'comboL' ? 'attackL' : 'attackH';
  f.stateFrame = 0; f.hasHit = false; f.swung = false; f.spawned = false;
  events.push({ t: 'comboStage', side: idx + 1, stage: f.comboStage });
}

// Cancelling a dash into an action just clears the remaining dash frames so the
// dash-cleanup in stepTimers does not later reset the new state.
function clearDash(f) { f.dashTtl = 0; }

// v2.1 DASH: toward/neutral = fast forward dash (attack-cancelable after 4f);
// away = back dash with 6f invuln. 24f cooldown. Returns true if a dash started.
function startDash(state, idx, mask, events) {
  const f = state.fighters[idx];
  const opp = state.fighters[otherIdx(idx)];
  if (f.dashCd > 0 || f.airborne) return false;
  const towardBit = (opp.x >= f.x) ? IN_RIGHT : IN_LEFT;
  const awayBit = towardBit === IN_RIGHT ? IN_LEFT : IN_RIGHT;
  const dir = (opp.x >= f.x) ? 1 : -1;
  const back = (mask & awayBit) && !(mask & towardBit);
  f.dashCd = DASH_CD; f.crouching = false; f.blocking = false;
  f.hasHit = false; f.swung = false; f.moveCat = ''; f.move = '';
  if (back) {
    f.stateName = 'dashB'; f.stateFrame = 0; f.dashTtl = DASHB_TICKS;
    f.vx = -dir * DASHB_SPD;
    if (f.invulnTtl < DASHB_INVULN) f.invulnTtl = DASHB_INVULN;
    events.push({ t: 'dash', side: idx + 1, back: true });
  } else {
    f.stateName = 'dashF'; f.stateFrame = 0; f.dashTtl = DASHF_TICKS;
    f.vx = dir * DASHF_SPD;
    events.push({ t: 'dash', side: idx + 1, back: false });
  }
  return true;
}

// v2.4 AIR DASH: forward/back, mid-air, once per jump, FREE (no mana cost, no
// i-frames, no dashCd). Returns true if it started.
function startAirDash(state, idx, mask, events) {
  const f = state.fighters[idx];
  const opp = state.fighters[otherIdx(idx)];
  const towardBit = (opp.x >= f.x) ? IN_RIGHT : IN_LEFT;
  const awayBit = towardBit === IN_RIGHT ? IN_LEFT : IN_RIGHT;
  const dir = (opp.x >= f.x) ? 1 : -1;
  const back = (mask & awayBit) && !(mask & towardBit);
  f.crouching = false; f.blocking = false;
  f.hasHit = false; f.swung = false; f.moveCat = ''; f.move = '';
  f.airDashUsed = 1;
  f.dashTtl = AIRDASH_TICKS;
  f.vy = 0;
  if (back) {
    f.stateName = 'dashAirB'; f.stateFrame = 0;
    f.vx = -dir * AIRDASH_SPD;
    events.push({ t: 'airdash', side: idx + 1, back: true, x: f.x, y: f.y });
  } else {
    f.stateName = 'dashAirF'; f.stateFrame = 0;
    f.vx = dir * AIRDASH_SPD;
    events.push({ t: 'airdash', side: idx + 1, back: false, x: f.x, y: f.y });
  }
  return true;
}

function startSpecial(f, dir) {
  const F = FIGHTERS[f.id];
  const sp = F.specials[dir] || F.specials.fwd;
  f.moveCat = 'special'; f.move = F.specials[dir] ? dir : 'fwd';
  f.stateName = 'special'; f.stateFrame = 0; f.hasHit = false; f.spawned = false; f.swung = false;
  f.vx = 0; f.crouching = false; f.blocking = false;
  if (sp.kind === 'antiair') { f.invulnTtl = sp.invuln || 0; }
  return sp;
}

// v2 ULTIMATE: fixed deterministic sequence. Enter a 90-tick cinematic freeze
// (both fighters frozen, timer paused), then the super's normal startup/active
// frames run and a full-screen beam fires from the hand anchor.
// v2.5: the freeze is preceded by a short REACTION WINDOW - see the branch below.
function startSuper(state, idx, events) {
  const f = state.fighters[idx];
  const sp = FIGHTERS[f.id].super;
  f.meter -= 100; if (f.meter < 0) f.meter = 0;
  f.moveCat = 'super'; f.move = 'super';
  f.stateName = 'super'; f.stateFrame = 0; f.hasHit = false; f.spawned = false; f.swung = false;
  f.vx = 0; f.crouching = false; f.blocking = false;
  f.combo = 0;                 // super damage is not combo-scaled
  f.invulnTtl = 60;            // covers the post-freeze active window
  const mySide = idx + 1;
  if (state.ultChallenge > 0 && state.ultChallengeSide !== mySide) {
    // RESPONDER answered within the reaction window -> collapse BOTH fighters into the
    // synced cinematic freeze so their beams spawn on the SAME post-freeze tick (a
    // deferred same-tick clash). The clash cinematic owns the visuals, so no 'ultimate'
    // event is pushed here; maybeStartClash forms the duel after the freeze.
    const initIdx = state.ultChallengeSide - 1;
    const fi = state.fighters[initIdx];
    state.ultChallenge = 0; state.ultChallengeSide = 0;
    fi.stateFrame = 0; fi.spawned = false;
    f.stateFrame = 0; f.spawned = false;
    state.freeze = CINEMATIC_FREEZE; state.freezeSide = mySide;
  } else {
    // INITIATOR (or the first presser on a same-tick double) -> OPEN the reaction window.
    // The 'ultimate' / 'superFlash' cinematic events are DEFERRED to window expiry (in
    // ultChallengeStep) so the single-actor cinematic never starts for a clash.
    state.ultChallenge = ULT_CHALLENGE_WINDOW; state.ultChallengeSide = mySide;
    events.push({ t: 'ultChallenge', side: mySide, x: f.x, y: f.y - 180000,
      data: { window: ULT_CHALLENGE_WINDOW, respSide: (idx === 0 ? 2 : 1), name: sp.name, edison: f.id === 'edison' } });
  }
}

// v2 TRANSFORM: 45-tick commit. Interruptible (any hit cancels via applyHit).
function startTransform(state, idx, events) {
  const f = state.fighters[idx];
  f.stateName = 'transform'; f.stateFrame = 0; f.transformTtl = TRANSFORM_TICKS;
  f.charging = false; f.vx = 0; f.crouching = false;
  f._txStart = true; // don't burn a tick on the entry frame (see stepTimers)
  events.push({ t: 'transformStart', side: idx + 1, x: f.x, y: f.y - 180000, data: { form: f.form } });
}

function startAbility(state, idx, events) {
  const f = state.fighters[idx];
  const opp = state.fighters[otherIdx(idx)];
  const ab = FIGHTERS[f.id].ability;
  if (f.abilityCd > 0) return false;
  switch (ab.kind) {
    case 'parry': {
      if (f.abilityUsedRound) return false;
      f.abilityUsedRound = true;
      f.reduceTtl = ab.dur; f.parryTtl = ab.dur; f.stateName = 'parry'; f.stateFrame = 0;
      f.abilityCd = ab.cd; f.vx = 0;
      events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 180000, data: { ability: 'constitution' } });
      return true;
    }
    case 'flurry': {
      f.flurryLeft = ab.shots; f.flurryTtl = 0;
      f.abilityCd = ab.cd;
      events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 180000, data: { ability: 'token_stream' } });
      return true;
    }
    case 'teleport': {
      const behind = opp.x - opp.facing * ab.offset;
      f.x = clampX(behind);
      f.facing = (opp.x >= f.x) ? 1 : -1;
      f.invulnTtl = 8; f.abilityCd = ab.cd;
      events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 180000, data: { ability: 'twin_swap' } });
      return true;
    }
    case 'cmdthrow': {
      const dist = Math.abs(opp.x - f.x);
      f.abilityCd = ab.cd;
      if (dist <= ab.range && !opp.airborne && opp.invulnTtl <= 0) {
        const roll = nextRng(state);
        const dmg = ab.min + (roll % (ab.max - ab.min + 1));
        const finalDmg = Math.floor(dmg * f.statMille / 1000);
        opp.hp -= finalDmg; if (opp.hp < 0) opp.hp = 0;
        opp.tookDamage = true;
        opp.hitstun = 26; opp.stateName = 'hitstun'; opp.airborne = true; opp.vy = -14000; opp.airHurt = true;
        opp.moveCat = ''; opp.move = '';
        f.meter = clampMeter(f.meter + meterGain(f, 10));
        events.push({ t: 'throw', side: idx + 1, x: opp.x, y: opp.y - 160000, data: { ability: 'chaos_roulette', dmg: finalDmg } });
      } else {
        events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 180000, data: { ability: 'chaos_roulette', whiff: 1 } });
      }
      return true;
    }
    case 'autoparry': {
      f.autoParryTtl = ab.window; f.abilityCd = ab.cd;
      events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 180000, data: { ability: 'autocomplete' } });
      return true;
    }
    case 'slide': {
      f.slideTtl = ab.dur; f.projImmuneTtl = ab.dur; f.stateName = 'slide'; f.stateFrame = 0;
      f.vx = f.facing * Math.floor(ab.dist / ab.dur); f.hasHit = false; f.swung = false; f.abilityCd = ab.cd;
      f._slideDmg = ab.dmg;
      events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 60000, data: { ability: 'deep_dive' } });
      // slide is a low melee strike - emit its swing immediately (active from frame 0).
      events.push({ t: 'swing', side: idx + 1, x: f.x + f.facing * FIGHTERS[f.id].hw, y: f.y - 60000, data: { heavy: false } });
      f.swung = true;
      return true;
    }
    case 'summon': {
      for (let k = 0; k < ab.count; k++) {
        const off = 40000 + k * 60000;
        spawnSummon(state, idx + 1, clampX(f.x - f.facing * off), f.facing, Math.floor(ab.dmg * f.statMille / 1000), ab.ttl, ab.speed, 1);
      }
      f.abilityCd = ab.cd;
      events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 180000, data: { ability: ab.name, summons: ab.count } });
      return true;
    }
    default: return false;
  }
}

function startThrow(state, idx, events) {
  const f = state.fighters[idx];
  const opp = state.fighters[otherIdx(idx)];
  const F = FIGHTERS[f.id];
  const dist = Math.abs(opp.x - f.x);
  if (dist > F.throwRange || opp.airborne || opp.invulnTtl > 0 || opp.stateName === 'ko') {
    // whiffed throw: brief recovery
    f.moveCat = ''; f.move = ''; f.stateName = 'throw'; f.stateFrame = 0; f._throwWhiff = 18;
    return false;
  }
  f.stateName = 'throw'; f.stateFrame = 0; f.vx = 0; f.blocking = false; f.crouching = false;
  f.throwTarget = otherIdx(idx) + 1; f.throwTimer = 12; f._throwWhiff = 0;
  opp.beingThrown = true; opp.stateName = 'thrown'; opp.throwTechTtl = 10; opp.vx = 0;
  opp.moveCat = ''; opp.move = '';
  return true;
}

// ---- per-fighter input step ------------------------------------------------
function stepInput(state, idx, mask, events) {
  const f = state.fighters[idx];
  const opp = state.fighters[otherIdx(idx)];

  // Record the current mask FIRST (used by hit-time blocking, throw-tech, edge
  // detection + hashing) - even while stunned/thrown/ko, so f.inMask is current.
  const prevMask = f.inMask;
  f.inMask = mask;
  f._mask = mask;

  if (f.stateName === 'ko' || f.beingThrown) return;

  const actionable = isActionable(f);
  const attacking = (f.stateName === 'attackL' || f.stateName === 'attackH');
  // A move that has ALREADY connected this swing (hasHit) can be cancelled while
  // inside the cancel window.
  const canCancel = attacking && f.hasHit && (f.chainTtl > 0 || f.specialTtl > 0);
  // Forward dash becomes attack-cancelable after DASHF_CANCEL frames.
  const dashCancelable = (f.stateName === 'dashF' && f.stateFrame >= DASHF_CANCEL);
  const canAct = actionable || canCancel || dashCancelable;

  const L = mask & IN_LIGHT, H = mask & IN_HEAVY, B = mask & IN_BLAST;
  const towardBit = (opp.x >= f.x) ? IN_RIGHT : IN_LEFT;
  const inComboL = f.moveCat === 'comboL';
  const inComboH = f.moveCat === 'comboH';

  // ---- ULTIMATE (LIGHT+HEAVY+BLAST at full meter): the ONLY chord ----------
  // With the old H+S throw / L+S ability chords gone, an imperfectly-timed
  // 3-button ultimate can no longer be "eaten" by a throw/ability - a partial
  // 2-bit mask is just a harmless blast, and the ultimate fires the moment all
  // three land. (Verified per-fighter incl. Edison.)
  if (L && H && B) {
    // v2.3: RETURN after committing the super (like every other action starter).
    // Without this, the stale `actionable` snapshot let the movement code below
    // overwrite stateName back to 'idle', so the fighter read as actionable after
    // the freeze and its own next input cancelled the super before the beam spawned
    // (CPU ultimates never fired their beam; two CPUs could never clash).
    if (f.meter >= 100 && canAct) { clearDash(f); startSuper(state, idx, events); return; }
    // no meter / not actionable: fall through (movement ignores L/H/B bits)
  } else if (B) {
    // ---- BLAST family (circle) -------------------------------------------
    if (mask & IN_DOWN) {
      // down+BLAST = signature ability (edge-triggered so a held press can't
      // re-fire / re-grab every actionable frame).
      const freshB = !(prevMask & IN_BLAST);
      if (actionable && freshB) { clearDash(f); startAbility(state, idx, events); }
      return;
    }
    if (mask & IN_UP) {
      // up+BLAST = anti-air special (rising) - FREE, no mana cost.
      if (canAct) {
        clearDash(f);
        const sp = startSpecial(f, 'up');
        events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 160000, data: { move: 'up', name: sp.name, antiair: true } });
        return;
      }
    } else if (mask & towardBit) {
      // fwd+BLAST = heavy blast variant. Mana-gated (v2.4): only starts with
      // enough mana; startup/travel speed are unchanged, only the gate/spend is new.
      if (canAct && f.mana >= MANA_COST_BLASTHV) {
        clearDash(f);
        const sp = startSpecial(f, 'blastHeavy');
        f.mana -= MANA_COST_BLASTHV;
        events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 160000, data: { move: 'blastHeavy', name: sp.name, heavy: true } });
        return;
      } else if (canAct && !(prevMask & IN_BLAST)) {
        events.push({ t: 'manaEmpty', side: idx + 1 });
      }
    } else {
      // neutral BLAST = ki projectile. Mana-gated (v2.4): insufficient mana is a
      // harmless no-op press - fall through so movement still works below.
      if (canAct && f.mana >= MANA_COST_BLAST) {
        clearDash(f);
        const sp = startSpecial(f, 'blast');
        f.mana -= MANA_COST_BLAST;
        events.push({ t: 'special', side: idx + 1, x: f.x, y: f.y - 160000, data: { move: 'blast', name: sp.name } });
        return;
      } else if (canAct && !(prevMask & IN_BLAST)) {
        events.push({ t: 'manaEmpty', side: idx + 1 });
      }
    }
  } else if (H) {
    // ---- HEAVY: fwd+heavy point-blank throw, or heavy auto-combo ----------
    const freshH = !(prevMask & IN_HEAVY);
    if (actionable && !f.airborne && !inComboH && freshH && (mask & towardBit)
      && Math.abs(opp.x - f.x) <= FIGHTERS[f.id].throwRange) {
      clearDash(f); startThrow(state, idx, events); return;
    }
    if (inComboH && f.hasHit && f.chainTtl > 0 && freshH) {
      if (f.comboStage < FIGHTERS[f.id].comboHeavy.length - 1) advanceCombo(f, events, idx);
      return;
    }
    if (freshH && canAct && !inComboH) { clearDash(f); startCombo(f, 'heavy', events, idx); return; }
  } else if (L) {
    // ---- LIGHT: crouch-low, combo advance, or light auto-combo ------------
    const freshL = !(prevMask & IN_LIGHT);
    if (inComboL && f.hasHit && f.chainTtl > 0 && freshL) {
      if (f.comboStage < FIGHTERS[f.id].comboLight.length - 1) advanceCombo(f, events, idx);
      return;
    }
    if (freshL && canAct && !inComboL) {
      if ((mask & IN_DOWN) && FIGHTERS[f.id].moves.cLight) { clearDash(f); startNormalLow(f); return; }
      clearDash(f); startCombo(f, 'light', events, idx); return;
    }
  }

  // ---- DASH (cross) edge-triggered -----------------------------------------
  const freshDash = (mask & IN_DASH) && !(prevMask & IN_DASH);
  if (freshDash && actionable && !f.airborne) {
    if (startDash(state, idx, mask, events)) return;
  } else if (freshDash && f.airborne && !f.airDashUsed && f.hitstun <= 0) {
    // v2.4 AIR DASH: forward/back, mid-air, once per jump, FREE (no mana check).
    if (startAirDash(state, idx, mask, events)) return;
  }

  if (!actionable) return; // committed to current action; let it run

  // ---- v2 POWER: charge ki -> transform (grounded only) ------------------
  if (!f.airborne && (mask & IN_POWER)) {
    if (f.stateName !== 'charge') { f.stateName = 'charge'; f.stateFrame = 0; }
    f.charging = true; f.vx = 0; f.crouching = false; f.blocking = false;
    if (f.ki < KI_MAX) {
      f.kiSub += KI_STEP;
      while (f.kiSub >= KI_DEN && f.ki < KI_MAX) { f.ki += 1; f.kiSub -= KI_DEN; }
      if (f.ki >= KI_MAX) {
        f.ki = KI_MAX; f.kiSub = 0;
        events.push({ t: 'kiFull', side: idx + 1, x: f.x, y: f.y - 200000 });
      }
    }
    // Full ki while charging -> immediately begin the transform (deterministic).
    if (f.ki >= KI_MAX && f.form < lastFormIdx(f)) startTransform(state, idx, events);
    return;
  }
  if (f.stateName === 'charge') { f.charging = false; f.stateName = 'idle'; }

  // ---- movement / stance (grounded, actionable, not attacking) -----------
  const fwdBit = f.facing > 0 ? IN_RIGHT : IN_LEFT;
  const backBit = f.facing > 0 ? IN_LEFT : IN_RIGHT;

  if (f.airborne) return; // air control fixed at jump time

  // facing auto-turn while grounded neutral
  f.facing = (opp.x >= f.x) ? 1 : -1;

  const down = mask & IN_DOWN;
  const up = mask & IN_UP;
  const back = mask & backBit;
  const fwd = mask & fwdBit;

  if (up) {
    // jump
    f.airborne = true; f.stateName = 'jump'; f.stateFrame = 0;
    f.airDashUsed = 0; // v2.4: a fresh jump grants a fresh air dash
    f.vy = -FIGHTERS[f.id].jumpVel;
    const jws = walkSpeedOf(f);
    f.vx = fwd ? f.facing * Math.floor(jws * 8 / 10)
      : (back ? -f.facing * Math.floor(jws * 7 / 10) : 0);
    f.crouching = false; f.blocking = false;
    return;
  }

  if (down) {
    // crouch (holds position). Low-block vs an attack is decided at hit time
    // from the current input (down-back), not a persistent stance.
    f.crouching = true; f.vx = 0; f.blocking = false; f.stateName = 'crouch';
    return;
  }
  f.crouching = false;
  f.blocking = false;

  const ws = walkSpeedOf(f);
  if (fwd) {
    f.vx = f.facing * ws; f.stateName = 'walk';
  } else if (back) {
    // v2: holding back WALKS BACKWARD (blocking is now a hit-time decision).
    f.vx = -f.facing * Math.floor(ws * 7 / 10); f.stateName = 'walk';
  } else {
    f.vx = 0; f.stateName = 'idle';
  }
}

// ---- physics + timers ------------------------------------------------------
function stepPhysics(state, idx, events) {
  const f = state.fighters[idx];
  if (f.stateName === 'ko') { f.vx = 0; f.vy = 0; return; }

  if (f.airborne) {
    // v2.4 AIR DASH: float (no gravity) while dashTtl is still counting down; once
    // it expires mid-air, drop back to the normal 'jump' state so gravity resumes.
    const airDashing = (f.stateName === 'dashAirF' || f.stateName === 'dashAirB') && f.dashTtl > 0;
    if (airDashing) {
      // suppress gravity this tick - horizontal float only
    } else {
      if (f.stateName === 'dashAirF' || f.stateName === 'dashAirB') f.stateName = 'jump';
      f.vy += GRAVITY;
    }
    f.y += f.vy;
    f.x = clampX(f.x + f.vx);
    if (f.y >= FLOOR_Y) {
      f.y = FLOOR_Y; f.vy = 0; f.vx = 0; f.airborne = false; f.airHurt = false; f.juggle = 0;
      f.airDashUsed = 0; // v2.4: landing refreshes the air dash for the next jump
      if (f.hitstun <= 0 && !f.beingThrown) { f.stateName = 'land'; f.stateFrame = 0; }
      events.push({ t: 'land', side: idx + 1, x: f.x, y: f.y });
    }
  } else {
    f.x = clampX(f.x + f.vx);
    // slide movement handled via vx; friction when in slide handled by ttl
  }
}

function pushApart(state) {
  const a = state.fighters[0], b = state.fighters[1];
  const Fa = FIGHTERS[a.id], Fb = FIGHTERS[b.id];
  const minGap = Fa.hw + Fb.hw;
  const dx = b.x - a.x;
  const absdx = dx < 0 ? -dx : dx;
  if (absdx < minGap) {
    const overlap = minGap - absdx;
    const half = overlap >> 1;
    const dir = dx >= 0 ? 1 : -1;
    a.x = clampX(a.x - dir * half);
    b.x = clampX(b.x + dir * half);
  }
}

function stepTimers(state, idx, events) {
  const f = state.fighters[idx];
  f.stateFrame += 1;
  if (f.hitstun > 0) { f.hitstun -= 1; if (f.hitstun === 0 && !f.airborne) { f.stateName = 'idle'; f.combo = 0; } }
  // blockstun ends -> back to idle ('block' pose exists only during blockstun).
  if (f.blockstun > 0) { f.blockstun -= 1; if (f.blockstun === 0) { f.stateName = 'idle'; f.blocking = false; } }

  // v2 transform commitment: exactly TRANSFORM_TICKS ticks after entry (the entry
  // tick is skipped so start->complete spans the full window). On completion gain
  // the next form.
  if (f.stateName === 'transform' && f.transformTtl > 0) {
    if (f._txStart) {
      f._txStart = false;
    } else {
      f.transformTtl -= 1;
      if (f.transformTtl === 0) {
        f.form = Math.min(f.form + 1, lastFormIdx(f));
        f.ki = 0; f.kiSub = 0; f.charging = false;
        if (f.form > 0) f.formTtl = FORM_TTL; // v2.3: start the revert countdown
        if (f.invulnTtl < TRANSFORM_INVULN) f.invulnTtl = TRANSFORM_INVULN; // payoff i-frames
        f.stateName = 'idle'; f.vx = 0;
        if (events) events.push({ t: 'transform', side: idx + 1, x: f.x, y: f.y - 180000, data: { form: f.form } });
      }
    }
  }

  // v2.3 TIME-LIMITED TRANSFORM: an active form reverts to base after FORM_TTL
  // un-frozen ticks. Form multipliers (dmgPm/spdPm/meterPm/aura) are all computed
  // live from f.form via curForm(), so setting f.form=0 is the exact inverse of a
  // transform - no cached stats to unwind. Ki is cleared so the player must
  // re-charge to transform again. Paused during freeze + clash (belt-and-braces:
  // stepTimers is not reached in either phase) AND during an in-progress transform
  // (v2.3 FIX: else the prior form's expiring timer reverts f.form to 0 mid-anim
  // and the completing transform tiers up from 0, swallowing the earned tier).
  if (state.freeze === 0 && !state.clashActive && f.stateName !== 'transform' && f.formTtl > 0) {
    f.formTtl -= 1;
    if (f.formTtl === 0 && f.form > 0) {
      f.form = 0; f.ki = 0; f.kiSub = 0;
      events.push({ t: 'formRevert', side: idx + 1 });
    }
  }
  if (f.aiBlastCd > 0) f.aiBlastCd -= 1; // v2.3 CPU blast throttle

  // v2.4 MANA regen: same integer sub-accumulator pattern as the ki charge.
  // Runs every fight tick (stepTimers is skipped during freeze/clash, so regen
  // correctly pauses there too).
  if (f.mana < MANA_MAX) {
    f.manaSub += MANA_STEP;
    while (f.manaSub >= MANA_DEN && f.mana < MANA_MAX) { f.mana += 1; f.manaSub -= MANA_DEN; }
    if (f.mana > MANA_MAX) f.mana = MANA_MAX;
  }

  if (f.chainTtl > 0) f.chainTtl -= 1;
  if (f.specialTtl > 0) f.specialTtl -= 1;
  if (f.invulnTtl > 0) f.invulnTtl -= 1;
  if (f.projImmuneTtl > 0) f.projImmuneTtl -= 1;
  if (f.parryTtl > 0) f.parryTtl -= 1;
  if (f.reduceTtl > 0) f.reduceTtl -= 1;
  if (f.autoParryTtl > 0) f.autoParryTtl -= 1;
  if (f.abilityCd > 0) f.abilityCd -= 1;
  if (f.throwTechTtl > 0) f.throwTechTtl -= 1;
  if (f.dashCd > 0) f.dashCd -= 1;

  // dash lifecycle: forward/back dash ends after its window -> stop + idle.
  if (f.dashTtl > 0) {
    f.dashTtl -= 1;
    if (f.dashTtl === 0 && (f.stateName === 'dashF' || f.stateName === 'dashB')) {
      f.vx = 0; f.stateName = 'idle';
    }
  }

  // slide lifecycle
  if (f.slideTtl > 0) {
    f.slideTtl -= 1;
    if (f.slideTtl === 0) { f.vx = 0; f.stateName = 'idle'; f.hasHit = false; }
  }

  // attack/special/super/auto-combo lifecycle end. If the current stage runs out
  // its full frames without a chain advance, the combo resets to stage 0.
  if (f.moveCat === 'normal' || f.moveCat === 'comboL' || f.moveCat === 'comboH'
    || f.moveCat === 'special' || f.moveCat === 'super') {
    const mv = moveData(f);
    if (mv) {
      const total = mv.startup + mv.active + mv.recovery;
      if (f.stateFrame >= total) {
        f.moveCat = ''; f.move = ''; f.comboStage = 0; f.comboKind = '';
        f.stateName = f.airborne ? 'jump' : 'idle';
        f.vx = f.airborne ? f.vx : 0;
      }
    }
  }

  // parry stance ends
  if (f.stateName === 'parry' && f.parryTtl === 0) f.stateName = 'idle';

  // land recovery (brief)
  if (f.stateName === 'land' && f.stateFrame >= 3) f.stateName = 'idle';

  // throw whiff recovery
  if (f._throwWhiff > 0) { f._throwWhiff -= 1; if (f._throwWhiff === 0 && f.stateName === 'throw') { f.stateName = 'idle'; } }
}

// ---- dash / special movement during active ---------------------------------
// v2: all projectile/beam spawns use the per-move hand anchor (data.spawn) and
// emit a projectile event AT the anchor so the renderer draws the muzzle glow
// at the exact spawn point.
function stepMoveDrive(state, idx, events) {
  const f = state.fighters[idx];
  if (f.moveCat === 'special') {
    const sp = moveData(f);
    if (sp && sp.kind === 'dash') {
      if (f.stateFrame >= sp.startup && f.stateFrame < sp.startup + sp.active) {
        f.x = clampX(f.x + f.facing * Math.floor(sp.dash / sp.active));
      }
    } else if (sp && sp.kind === 'antiair') {
      if (f.stateFrame < 2) f.vy = -(sp.rise || 20000);
      if (!f.airborne && f.stateFrame < 2) f.airborne = true;
    } else if (sp && sp.kind === 'projectile') {
      if (f.stateFrame === sp.startup && !f.spawned) {
        f.spawned = true;
        f.aiBlastCd = AI_BLAST_CD; // v2.3: throttle CPU re-blasting (advisory field; harmless for humans)
        const a = spawnAnchor(f, sp.spawn);
        spawnProjectile(state, idx + 1, a.x, a.y,
          f.facing * sp.speed, Math.floor(sp.damage * f.statMille / 1000), sp.projTtl, sp.projW, sp.projH, 1);
        events.push({ t: 'projectile', side: idx + 1, x: a.x, y: a.y, data: { move: f.move } });
      }
    }
  } else if (f.moveCat === 'super') {
    const sp = moveData(f);
    // ULTIMATE beam: after the cinematic freeze the super's startup elapses, then
    // a full-screen-length beam fires from the hand anchor (Edison: his laptop).
    if (sp && f.stateFrame === sp.startup && !f.spawned) {
      f.spawned = true;
      const a = spawnAnchor(f, sp.spawn);
      // beam damage = base super x form (statMille + form applied once via applyHit)
      spawnProjectile(state, idx + 1, a.x, a.y, 0, sp.damage, 12, 2 * ARENA_MAX, 420000, 2);
      events.push({ t: 'projectile', side: idx + 1, x: a.x, y: a.y, data: { beam: true, edison: f.id === 'edison' } });
    }
  }
  // flurry projectile emission (chatty Token Stream), from the hand anchor.
  if (f.flurryLeft > 0) {
    if (f.flurryTtl <= 0) {
      const ab = FIGHTERS[f.id].ability;
      const a = spawnAnchor(f, ab.spawn);
      spawnProjectile(state, idx + 1, a.x, a.y,
        f.facing * ab.speed, Math.floor(ab.dmg * f.statMille / 1000), 90, 56000, 60000, 3);
      events.push({ t: 'projectile', side: idx + 1, x: a.x, y: a.y, data: { flurry: true } });
      f.flurryLeft -= 1;
      f.flurryTtl = ab.interval;
    } else {
      f.flurryTtl -= 1;
    }
  }
}

// ---- v2 swing events -------------------------------------------------------
// Emit ONE {t:'swing'} when a melee attack's active frames begin, at the
// striking limb's front edge. Projectile specials do not swing (they emit
// projectile events); the low slide emits its own swing at start.
function emitSwings(state, events) {
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    if (f.swung) continue;
    if (f.moveCat !== 'normal' && f.moveCat !== 'comboL' && f.moveCat !== 'comboH' && f.moveCat !== 'special') continue;
    const mv = moveData(f);
    if (!mv || !mv.hitbox) continue;
    if (f.moveCat === 'special' && mv.kind === 'projectile') continue;
    if (f.stateFrame < mv.startup || f.stateFrame >= mv.startup + mv.active) continue;
    const b = mv.hitbox;
    const frontX = f.facing > 0 ? f.x + b.ox + b.w : f.x - b.ox - b.w;
    const midY = f.y - b.oy - (b.h >> 1);
    const heavy = f.stateName === 'attackH' || f.moveCat === 'special' || f.moveCat === 'comboH';
    events.push({ t: 'swing', side: i + 1, x: frontX, y: midY, data: { heavy } });
    f.swung = true;
  }
}

// ---- collision resolution --------------------------------------------------
function resolveMelee(state, events) {
  for (let i = 0; i < 2; i++) {
    const atk = state.fighters[i];
    const def = state.fighters[otherIdx(i)];
    // slide low hit (seeker deep dive)
    if (atk.stateName === 'slide' && !atk.hasHit && atk._slideDmg) {
      const hb = { x0: atk.x - 80000, x1: atk.x + 80000, y0: atk.y - 90000, y1: atk.y };
      if (overlaps(hb, hurtRect(def))) {
        atk.hasHit = true;
        applyHit(state, i, otherIdx(i), { damage: atk._slideDmg, kind: 'slide', guard: 'low', hitstun: 18, blockstun: 10, pushback: 20000, meterGain: 6 }, 'melee', events);
      }
    }
    const rect = activeHitRect(atk);
    if (!rect) continue;
    const mv = moveData(atk);
    if (!mv) continue;
    if (overlaps(rect, hurtRect(def))) {
      atk.hasHit = true;
      applyHit(state, i, otherIdx(i), mv, 'melee', events);
    }
  }
}

function resolveProjectiles(state, events) {
  const pool = state.projectiles;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.active) continue;
    if (p.held) continue; // v2.3: clash-held beams are frozen - no move, no hit, no expiry
    p.x += p.vx; p.ttl -= 1;
    if (p.ttl <= 0 || p.x < -50000 || p.x > ARENA_MAX + 50000) { p.active = false; continue; }
    if (p.hasHit) continue;
    const defIdx = p.owner === 1 ? 1 : 0;
    const def = state.fighters[defIdx];
    const pr = { x0: p.x - (p.w >> 1), x1: p.x + (p.w >> 1), y0: p.y - (p.h >> 1), y1: p.y + (p.h >> 1) };
    if (overlaps(pr, hurtRect(def))) {
      const atkIdx = p.owner - 1;
      const hit = applyHit(state, atkIdx, defIdx, { damage: p.dmg, kind: 'projectile', guard: 'mid', hitstun: 16, blockstun: 11, pushback: 16000, meterGain: 6 }, 'projectile', events);
      if (hit || def.projImmuneTtl <= 0) { p.hasHit = true; p.active = false; }
    }
  }
}

function resolveSummons(state, events) {
  const pool = state.summons;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (!s.active) continue;
    s.x = clampX(s.x + s.vx); s.ttl -= 1; s.life += 1;
    if (s.ttl <= 0) { s.active = false; continue; }
    if (s.hasHit) continue;
    const defIdx = s.owner === 1 ? 1 : 0;
    const def = state.fighters[defIdx];
    const sr = { x0: s.x - (s.w >> 1), x1: s.x + (s.w >> 1), y0: s.y - s.h, y1: s.y };
    if (overlaps(sr, hurtRect(def))) {
      const atkIdx = s.owner - 1;
      applyHit(state, atkIdx, defIdx, { damage: s.dmg, kind: 'summon', guard: 'mid', hitstun: 16, blockstun: 10, pushback: 18000, meterGain: 4 }, 'summon', events);
      s.hasHit = true; s.active = false;
    }
  }
}

function resolveThrows(state, events) {
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    if (f.throwTimer > 0) {
      const opp = state.fighters[otherIdx(i)];
      // tech check: target holding HEAVY+BLAST within window (unchanged bit)
      if (opp.throwTechTtl > 0 && (opp._mask & IN_HEAVY) && (opp._mask & IN_BLAST)) {
        // teched
        f.throwTimer = 0; f.throwTarget = 0; f.stateName = 'idle';
        opp.beingThrown = false; opp.stateName = 'idle'; opp.throwTechTtl = 0;
        pushback(state, i, otherIdx(i), 40000, f.x <= opp.x ? -1 : 1);
        pushback(state, otherIdx(i), i, 40000, opp.x <= f.x ? -1 : 1);
        events.push({ t: 'throw', side: i + 1, x: f.x, y: f.y - 120000, data: { tech: 1 } });
        continue;
      }
      f.throwTimer -= 1;
      if (f.throwTimer === 0) {
        const dmg = Math.floor(FIGHTERS[f.id].throwDamage * f.statMille / 1000);
        opp.hp -= dmg; if (opp.hp < 0) opp.hp = 0;
        opp.tookDamage = true;
        opp.beingThrown = false; opp.stateName = 'hitstun'; opp.hitstun = 22;
        opp.airborne = true; opp.vy = -9500; opp.airHurt = true; // v2.2: shorter post-throw hang
        const dir = (opp.x >= f.x) ? 1 : -1;
        opp.x = clampX(opp.x + dir * 90000);
        f.stateName = 'idle';
        f.meter = clampMeter(f.meter + meterGain(f, 8));
        events.push({ t: 'throw', side: i + 1, x: opp.x, y: opp.y - 140000, data: { dmg } });
      }
    }
  }
}

// ---- combo reset -----------------------------------------------------------
function comboMaintenance(state) {
  for (let i = 0; i < 2; i++) {
    const atk = state.fighters[i];
    const def = state.fighters[otherIdx(i)];
    const inCombo = def.hitstun > 0 || def.blockstun > 0 || def.airHurt || def.beingThrown || def.stateName === 'thrown';
    if (!inCombo && atk.combo > 0) atk.combo = 0;
  }
}

// ---- KO / meter events -----------------------------------------------------
function checkMeterFull(state, prevMeter, events) {
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    if (prevMeter[i] < 100 && f.meter >= 100) {
      events.push({ t: 'meterFull', side: i + 1, x: f.x, y: f.y - 200000 });
    }
  }
}

// ---- round finalisation ----------------------------------------------------
function finalizeRound(state, winnerSide, reason, events) {
  state.phase = 'roundEnd';
  state.phaseTtl = ROUNDEND_TICKS;
  state.winner = winnerSide;
  if (winnerSide === 1 || winnerSide === 2) {
    const loser = state.fighters[otherIdx(winnerSide - 1)];
    const win = state.fighters[winnerSide - 1];
    loser.stateName = 'ko'; loser.vx = 0; loser.vy = 0;
    events.push({ t: 'ko', side: winnerSide, x: loser.x, y: loser.y - 120000, data: { reason } });
    if (!win.tookDamage) events.push({ t: 'perfect', side: winnerSide, x: win.x, y: win.y - 200000 });
  } else {
    events.push({ t: 'roundEnd', side: 0, x: 0, y: 0, data: { draw: 1, reason } });
  }
  events.push({ t: 'roundEnd', side: winnerSide, x: 0, y: 0, data: { reason } });
}

// ---- v2.3 ULTIMATE CLASH ---------------------------------------------------
// When two supers fire their kind=2 beams at once, they lock into a frozen
// button-mash duel instead of both whiffing on self-invuln. The player who
// mashes CLASH_ATTACK_BITS with more FRESH presses pushes the collision toward
// the loser; on resolve the winner's full super damage lands on the loser.

// First active beam (kind 2) owned by `owner` (1|2), or null.
function beamOf(state, owner) {
  const pool = state.projectiles;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (p.active && p.kind === 2 && p.owner === owner) return p;
  }
  return null;
}

// Any live projectile owned by `owner` (1|2)? (used by the CPU blast throttle).
function hasOwnProjectile(state, owner) {
  const pool = state.projectiles;
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].active && pool[i].owner === owner) return true;
  }
  return false;
}

// DETECTION: both fighters supering AND both have a live beam -> start the clash.
// Called after the beams have spawned (stepMoveDrive) but BEFORE resolveProjectiles
// so the two beams are not consumed by the normal whiff path.
function maybeStartClash(state, events) {
  if (state.clashActive) return;
  const f0 = state.fighters[0], f1 = state.fighters[1];
  if (f0.moveCat !== 'super' || f1.moveCat !== 'super') return;
  const b0 = beamOf(state, 1), b1 = beamOf(state, 2);
  if (!b0 || !b1) return;
  state.clashActive = 1;
  state.clashFrames = 0;
  state.clashMash0 = 0; state.clashMash1 = 0;
  state.clashPush = 0; state.clashWinner = 0;
  state.clashMidX = (f0.x + f1.x) >> 1;
  state.clashPrev0 = 0; state.clashPrev1 = 0;
  b0.held = 1; b1.held = 1;
  events.push({ t: 'clashStart', x: state.clashMidX, y: (b0.y + b1.y) >> 1 });
}

// One frozen clash tick: score fresh mashes, update push, resolve when capped.
function clashStep(state, in1, in2, events) {
  const a0 = (in1 | 0) & CLASH_ATTACK_BITS;
  const a1 = (in2 | 0) & CLASH_ATTACK_BITS;
  if ((a0 & ~state.clashPrev0) !== 0) state.clashMash0 += 1;
  if ((a1 & ~state.clashPrev1) !== 0) state.clashMash1 += 1;
  state.clashPrev0 = a0;
  state.clashPrev1 = a1;

  let push = (state.clashMash0 - state.clashMash1) * CLASH_MASH_STEP;
  if (push > CLASH_PUSH_MAX) push = CLASH_PUSH_MAX;
  else if (push < -CLASH_PUSH_MAX) push = -CLASH_PUSH_MAX;
  state.clashPush = push;

  state.clashFrames += 1;

  const pushAbs = push < 0 ? -push : push;
  if (state.clashFrames >= CLASH_MAX_FRAMES || pushAbs >= CLASH_PUSH_MAX) {
    const winner = state.clashMash0 > state.clashMash1 ? 1
      : (state.clashMash1 > state.clashMash0 ? 2 : (state.clashPush >= 0 ? 1 : 2));
    const winnerIdx = winner - 1;
    const loserIdx = winner === 1 ? 1 : 0;
    const win = state.fighters[winnerIdx];
    const lose = state.fighters[loserIdx];
    // clash payoff: winner's full super damage lands on the loser. Ignore the
    // loser's own super-invuln / auto-parry / damage-reduce - this is the reward.
    lose.invulnTtl = 0; lose.autoParryTtl = 0; lose.reduceTtl = 0;
    // grab the beam y for the render event before deactivating.
    let beamY = win.y - 180000;
    const pool = state.projectiles;
    for (let i = 0; i < pool.length; i++) { if (pool[i].held) { beamY = pool[i].y; break; } }
    applyHit(state, winnerIdx, loserIdx, FIGHTERS[win.id].super, 'super', events);
    // v2.3 FIX: END the winner's super cleanly (mirror the natural move-end) so the
    // frozen stateFrame=8 (inside the super's active window) cannot re-connect its
    // melee OR re-spawn its beam next frame - a second full super hit. applyHit
    // does NOT set the attacker's hasHit, and its projectile guard only nulls
    // moveCat==='special', so the 'super' rect would stay live otherwise. (The
    // loser is already neutralized by applyHit's hitstun.)
    win.moveCat = ''; win.move = ''; win.comboStage = 0; win.comboKind = '';
    win.stateName = win.airborne ? 'jump' : 'idle';
    win.hasHit = true;
    for (let i = 0; i < pool.length; i++) { const p = pool[i]; if (p.held) { p.held = 0; p.active = false; } }
    state.clashActive = 0;
    state.clashWinner = winner;
    events.push({ t: 'clashResolve', winner, x: state.clashMidX, y: beamY });
  }
}

// One frozen reaction-window tick (v2.5). Both fighters are frozen; only the
// RESPONDER's ultimate chord is scanned. If they answer (meter>=100), startSuper's
// responder branch collapses both into the synced freeze -> clash. On expiry, the
// initiator falls through to a normal single ultimate (deferred cinematic fires here).
function ultChallengeStep(state, in1, in2, events) {
  const initIdx = state.ultChallengeSide - 1;
  const respIdx = otherIdx(initIdx);
  const f = state.fighters[respIdx];
  const mask = (respIdx === 0 ? in1 : in2) & IN_MASK;
  const chord = (mask & IN_LIGHT) && (mask & IN_HEAVY) && (mask & IN_BLAST);
  if (chord && f.meter >= 100 && f.stateName !== 'ko' && !f.beingThrown) {
    // Responder answers -> startSuper (responder branch) syncs both + starts the freeze.
    startSuper(state, respIdx, events);
    return;
  }
  state.ultChallenge -= 1;
  if (state.ultChallenge === 0) {
    // No answer in time -> the initiator proceeds as a normal single ultimate. Fire the
    // deferred cinematic events now (they were held back in startSuper) and hand off to
    // the standard cinematic freeze; its beam spawns and hits after the freeze.
    const fi = state.fighters[initIdx];
    const iSide = state.ultChallengeSide;
    state.ultChallengeSide = 0;
    fi.stateFrame = 0; fi.spawned = false;
    state.freeze = CINEMATIC_FREEZE; state.freezeSide = iSide;
    const sp = FIGHTERS[fi.id].super;
    events.push({ t: 'ultimate', side: iSide, x: fi.x, y: fi.y - 180000, data: { name: sp.name, edison: fi.id === 'edison' } });
    events.push({ t: 'superFlash', side: iSide, x: fi.x, y: fi.y - 180000, data: { name: sp.name } });
  }
}

// ---- main step -------------------------------------------------------------
export function stepMatch(state, in1, in2) {
  const events = state.lastEvents = [];
  in1 = (in1 | 0) & IN_MASK; in2 = (in2 | 0) & IN_MASK;  // v3: 10-bit masks (DASH=512)

  if (state.phase === 'over') return events;

  state.frame += 1;

  if (state.phase === 'intro') {
    state.phaseTtl -= 1;
    if (state.phaseTtl <= 0) {
      state.phase = 'fight';
      events.push({ t: 'roundStart', side: 0, x: 0, y: 0, data: { round: state.round } });
    }
    return events;
  }

  if (state.phase === 'roundEnd') {
    state.phaseTtl -= 1;
    if (state.phaseTtl <= 0) {
      if (state.winner === 1 || state.winner === 2) {
        state.wins[state.winner - 1] += 1;
        if (state.wins[state.winner - 1] >= state.roundsToWin) {
          state.phase = 'over';
          events.push({ t: 'matchEnd', side: state.winner, x: 0, y: 0, data: { wins: state.wins.slice() } });
          return events;
        }
        state.round += 1;
      }
      // draw -> replay same round (no pip, no round increment)
      resetForRound(state);
    }
    return events;
  }

  // ---- phase 'fight' -------------------------------------------------------
  // v2.5 ULTIMATE REACTION WINDOW: after A fires, both fighters freeze for a short
  // beat during which B may answer with its own ultimate to force a clash. Runs
  // BEFORE the cinematic freeze so B's input isn't dropped by it. Either collapses
  // into the freeze (with both committed -> clash, or just the initiator -> single ult).
  if (state.ultChallenge > 0) {
    ultChallengeStep(state, in1, in2, events);
    return events;
  }

  // v2 ULTIMATE cinematic freeze: both fighters frozen, timer paused, purely
  // presentation. Runs for exactly CINEMATIC_FREEZE ticks after a super starts.
  if (state.freeze > 0) {
    state.freeze -= 1;
    if (state.freeze === 0) state.freezeSide = 0;
    return events;
  }

  // v2.3 ULTIMATE CLASH: while the mash duel is live, fighters are frozen and only
  // the duel advances (like the freeze phase). Held beams sit still until resolve.
  if (state.clashActive) {
    clashStep(state, in1, in2, events);
    return events;
  }

  const prevMeter = [state.fighters[0].meter, state.fighters[1].meter];

  comboMaintenance(state);

  stepInput(state, 0, in1, events);
  stepInput(state, 1, in2, events);

  stepMoveDrive(state, 0, events);
  stepMoveDrive(state, 1, events);

  stepPhysics(state, 0, events);
  stepPhysics(state, 1, events);

  emitSwings(state, events);

  // v2.3 CLASH DETECTION: two live super-beams lock into a mash duel. Must run
  // BEFORE resolveProjectiles (which would otherwise consume both beams as whiffs)
  // and BEFORE the frozen fighters' timers advance.
  maybeStartClash(state, events);
  if (state.clashActive) return events;

  resolveMelee(state, events);
  resolveProjectiles(state, events);
  resolveSummons(state, events);
  resolveThrows(state, events);

  pushApart(state);

  stepTimers(state, 0, events);
  stepTimers(state, 1, events);

  checkMeterFull(state, prevMeter, events);

  // KO check
  const f0 = state.fighters[0], f1 = state.fighters[1];
  if (f0.hp <= 0 || f1.hp <= 0) {
    let winner = 0;
    if (f0.hp <= 0 && f1.hp <= 0) winner = 0; // double KO -> draw
    else if (f1.hp <= 0) winner = 1;
    else winner = 2;
    finalizeRound(state, winner, 'ko', events);
    return events;
  }

  // timer
  state.timer -= 1;
  if (state.timer <= 0) {
    let winner;
    if (f0.hp > f1.hp) winner = 1;
    else if (f1.hp > f0.hp) winner = 2;
    else winner = 0; // tie -> replay
    events.push({ t: 'timeout', side: winner, x: 0, y: 0 });
    finalizeRound(state, winner, 'timeout', events);
    return events;
  }

  return events;
}

// ---- hashState (FNV-1a-ish over gameplay ints) -----------------------------
function fnv(h, v) { return Math.imul(h ^ (v | 0), 16777619) >>> 0; }

export function hashState(state) {
  let h = 2166136261 >>> 0;
  h = fnv(h, state.frame);
  h = fnv(h, state.round);
  h = fnv(h, state.timer);
  h = fnv(h, PHASE_CODE[state.phase] || 0);
  h = fnv(h, state.phaseTtl);
  h = fnv(h, state.wins[0]); h = fnv(h, state.wins[1]);
  h = fnv(h, state.winner);
  h = fnv(h, state.rng);
  h = fnv(h, state.freeze); h = fnv(h, state.freezeSide);
  // v2.5 ultimate reaction window
  h = fnv(h, state.ultChallenge); h = fnv(h, state.ultChallengeSide);
  // v2.3 clash state
  h = fnv(h, state.clashActive); h = fnv(h, state.clashFrames);
  h = fnv(h, state.clashMash0); h = fnv(h, state.clashMash1);
  h = fnv(h, state.clashPush); h = fnv(h, state.clashWinner);
  h = fnv(h, state.clashMidX); h = fnv(h, state.clashPrev0); h = fnv(h, state.clashPrev1);
  for (let i = 0; i < 2; i++) {
    const f = state.fighters[i];
    h = fnv(h, f.x); h = fnv(h, f.y); h = fnv(h, f.vx); h = fnv(h, f.vy);
    h = fnv(h, f.hp); h = fnv(h, f.meter); h = fnv(h, f.facing);
    h = fnv(h, STATE_CODE[f.stateName] || 0); h = fnv(h, f.stateFrame);
    h = fnv(h, f.combo); h = fnv(h, f.juggle);
    h = fnv(h, (f.blocking ? 1 : 0) | (f.crouching ? 2 : 0) | (f.airborne ? 4 : 0) | (f.charging ? 8 : 0)
      | (f.hasHit ? 16 : 0) | (f.spawned ? 32 : 0) | (f.swung ? 64 : 0) | (f.airHurt ? 128 : 0)
      | (f.abilityUsedRound ? 256 : 0) | (f.beingThrown ? 512 : 0) | (f.tookDamage ? 1024 : 0));
    h = fnv(h, f.hitstun); h = fnv(h, f.blockstun);
    h = fnv(h, f.invulnTtl); h = fnv(h, f.reduceTtl); h = fnv(h, f.autoParryTtl);
    h = fnv(h, f.slideTtl); h = fnv(h, f.flurryLeft); h = fnv(h, f.throwTimer);
    // v2 additions
    h = fnv(h, f.form); h = fnv(h, f.ki); h = fnv(h, f.kiSub);
    h = fnv(h, f.transformTtl); h = fnv(h, f.inMask);
    // v2.1 additions
    h = fnv(h, f.comboStage); h = fnv(h, f.dashCd); h = fnv(h, f.dashTtl);
    // v2.3 additions
    h = fnv(h, f.formTtl); h = fnv(h, f.aiBlastCd);
    // v2.4 additions
    h = fnv(h, f.mana); h = fnv(h, f.manaSub); h = fnv(h, f.airDashUsed);
    // desync audit (2026-07): fields mutated by the sim but previously missing
    // from the hash. moveCat/move/comboKind are bounded string enums mapped
    // through the small code tables above (same pattern as STATE_CODE); the
    // rest are plain persistent ints. throwTarget is already a side index
    // (0/1/2, see startThrow), not an object ref, so it hashes directly.
    h = fnv(h, MOVECAT_CODE[f.moveCat] || 0); h = fnv(h, MOVE_CODE[f.move] || 0);
    h = fnv(h, COMBOKIND_CODE[f.comboKind] || 0);
    h = fnv(h, f.chainTtl); h = fnv(h, f.specialTtl); h = fnv(h, f.projImmuneTtl);
    h = fnv(h, f.parryTtl); h = fnv(h, f.abilityCd); h = fnv(h, f.flurryTtl);
    h = fnv(h, f.throwTarget); h = fnv(h, f.throwTechTtl);
    h = fnv(h, f._throwWhiff | 0);
  }
  const pp = state.projectiles;
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i];
    h = fnv(h, p.active ? 1 : 0); h = fnv(h, p.x); h = fnv(h, p.vx); h = fnv(h, p.dmg); h = fnv(h, p.ttl); h = fnv(h, p.owner);
    h = fnv(h, p.held ? 1 : 0); // v2.3 clash-held beams
  }
  const ss = state.summons;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    h = fnv(h, s.active ? 1 : 0); h = fnv(h, s.x); h = fnv(h, s.vx); h = fnv(h, s.dmg); h = fnv(h, s.ttl); h = fnv(h, s.owner);
  }
  return h >>> 0;
}

// ---- serialize / deserialize ----------------------------------------------
// state is already plain JSON; deep-clone to guarantee structured-clone safety
// and detachment from the live object.
export function serialize(state) { return JSON.parse(JSON.stringify(state)); }
export function deserialize(obj) { return JSON.parse(JSON.stringify(obj)); }

// ---- CPU AI ----------------------------------------------------------------
// Deterministic: reads only state data + a PURE mix of state.rng/frame/side.
// Never mutates state, never calls Math.random. Levels per thresholds.md:
//   L1 = 24f reaction + 20% action, L2 = 14f + 45%, L3 = 8f + 70% + combos.
export function cpuInput(state, side, level) {
  if (state.phase !== 'fight') return 0;
  const idx = side - 1;
  const f = state.fighters[idx];
  const opp = state.fighters[otherIdx(idx)];
  // v2.3 ULTIMATE CLASH: mash CLASH_ATTACK_BITS with FRESH edges to win the beam
  // duel. Toggle on/off by frame parity (faster at higher level) so each press is
  // a fresh edge (press, release, press). Period per level from CLASH_CPU_PERIOD
  // (easy ~7.5/s, medium ~12/s, hard ~20/s). Determined purely by state.frame - no
  // RNG, fully deterministic. So easy = out-mash it by tapping, hard = drum fast.
  if (state.clashActive) {
    const period = CLASH_CPU_PERIOD[level] || 5;
    return (state.frame % period === 0) ? CLASH_ATTACK_BITS : 0;
  }

  // v2.5 REACTION WINDOW: if the OTHER side fired an ultimate and this CPU has a full
  // meter, answer with its own after a level-scaled reaction delay (higher level =
  // faster). Driven purely by the synced ultChallenge counter - no RNG. The initiator
  // side's input is ignored by the sim during the window, so returning 0 there is safe.
  if (state.ultChallenge > 0) {
    if (state.ultChallengeSide !== side && f.meter >= 100 && f.stateName !== 'ko' && !f.beingThrown) {
      const delay = level >= 3 ? 8 : (level >= 2 ? 16 : 28);
      return (ULT_CHALLENGE_WINDOW - state.ultChallenge) >= delay ? CLASH_ATTACK_BITS : 0;
    }
    return 0;
  }

  if (f.stateName === 'ko' || f.beingThrown) return 0;

  const react = level >= 3 ? 8 : (level >= 2 ? 14 : 24);
  const actRate = level >= 3 ? 70 : (level >= 2 ? 45 : 20);

  const toOpp = opp.x - f.x;
  const dist = toOpp < 0 ? -toOpp : toOpp;
  const facing = toOpp >= 0 ? 1 : -1;
  const fwdBit = facing > 0 ? IN_RIGHT : IN_LEFT;
  const backBit = facing > 0 ? IN_LEFT : IN_RIGHT;

  // pure per-tick rolls gated by reaction window (rollC decorrelates melee/blast mix)
  const roll = mix32(state.rng ^ Math.imul(state.frame, 2654435761) ^ Math.imul(side, 40503));
  const gate = (Math.floor(state.frame / react) + side) & 0xffff;
  const rollB = mix32(roll ^ gate);
  const rollC = mix32(rollB ^ 0x9e3779b9);
  const act = (rollB % 100) < actRate;

  // v2.3 blast throttle: only consider BLAST when NO own projectile is live AND the
  // post-blast cooldown has elapsed. This (plus the reduced blast odds below) kills
  // the old "always blasts" behaviour.
  const blastReady = !hasOwnProjectile(state, side) && f.aiBlastCd <= 0 && f.mana >= MANA_COST_BLAST;

  const CLOSE = 220000, MID = 460000;

  let mask = 0;

  // Defence: if opponent is attacking/committing and we are close, block.
  const oppAttacking = opp.stateName === 'attackL' || opp.stateName === 'attackH'
    || opp.stateName === 'special' || opp.stateName === 'super';
  if (dist < MID && oppAttacking && (rollB % 100) < (level >= 3 ? 55 : (level >= 2 ? 40 : 20))) {
    mask |= backBit;
    if (roll & 8) mask |= IN_DOWN; // sometimes low block
    return mask;
  }

  // Anti-air (L2+): opponent airborne + in range -> up+BLAST anti-air special.
  // (up+BLAST is the rising special, NOT a ki projectile, so it ignores blastReady.)
  if (level >= 2 && opp.airborne && dist < MID && act) {
    return IN_BLAST | IN_UP;
  }

  // Ultimate when full (L2+): LIGHT+HEAVY+BLAST is the only remaining chord.
  if (f.meter >= 100 && dist < CLOSE && level >= 2 && act) {
    return IN_LIGHT | IN_HEAVY | IN_BLAST;
  }

  // v2: charge ki -> transform when SAFE (opponent recovering/knocked/far).
  // Holding POWER long enough auto-transforms in core; L3 does it aggressively.
  const oppBusy = opp.stateName === 'hitstun' || opp.stateName === 'ko'
    || opp.stateName === 'blockstun' || opp.stateName === 'thrown'
    || opp.stateName === 'transform' || opp.beingThrown;
  if (level >= 2 && f.form < lastFormIdx(f) && f.ki < KI_MAX
    && !f.airborne && f.hitstun <= 0 && f.blockstun <= 0) {
    const safe = oppBusy || dist > MID;
    if ((level >= 3 && safe) || (level < 3 && oppBusy && dist > CLOSE)) {
      return IN_POWER;
    }
  }

  if (dist > MID) {
    // approach; sprinkle in an OCCASIONAL blast (~15%) only when one is ready, so
    // the CPU actually closes distance instead of camping projectiles.
    mask |= fwdBit;
    if (act && blastReady && (rollC % 100) < 15) mask |= IN_BLAST;
    return mask;
  }

  if (dist < CLOSE) {
    if (act) {
      const pick = rollC % 100;
      if (level >= 3 && pick < 18) return fwdBit | IN_HEAVY;        // throw attempt (v2.1 fwd+HEAVY)
      if (level >= 3 && pick < 30 && f.abilityCd <= 0) return IN_DOWN | IN_BLAST; // signature ability
      if (pick < 50) return IN_LIGHT;                               // jab / light auto-combo
      if (pick < 74) return IN_HEAVY;                               // heavy auto-combo
      if (pick < 88) return fwdBit | IN_LIGHT;                      // advancing light pressure
      if (blastReady && pick < 95) return IN_BLAST;                 // occasional point-blank blast
      return IN_LIGHT;                                              // default to MELEE, never spam blast
    }
    // L3 continues target-combo pressure after a landed hit
    if (level >= 3 && (f.stateName === 'attackL') && f.chainTtl > 0) return IN_HEAVY;
    // hold position / slight advance
    if (rollB & 4) mask |= fwdBit;
    return mask;
  }

  // MID range: space, poke, or advance - blast only when ready + throttled.
  if (act) {
    const pick = rollC % 100;
    if (pick < 40) { mask |= fwdBit; mask |= IN_HEAVY; return mask; } // advancing heavy poke
    if (blastReady && pick < 58) return IN_BLAST;                     // blast poke
    if (pick < 78) return IN_HEAVY;                                   // stationary heavy
    mask |= fwdBit; return mask;                                      // else approach
  }
  mask |= fwdBit;
  return mask;
}
