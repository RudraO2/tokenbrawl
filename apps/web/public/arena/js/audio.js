// js/audio.js - audio director. WebAudio, lazy-loaded ./assets/audio/*.mp3.
// Mobile autoplay policy: the AudioContext is only created/resumed from init(),
// which main.js calls on the first user gesture (keydown / pointerdown / touch button press).

const BASE = './assets/audio/';

const FILES = {
  music_title: 'music_title.mp3',
  music_battle: 'music_battle.mp3',
  sfx_hit_l: 'sfx_hit_l.mp3',
  sfx_hit_h: 'sfx_hit_h.mp3',
  sfx_special: 'sfx_special.mp3',
  sfx_ko: 'sfx_ko.mp3',
  sfx_bell: 'sfx_bell.mp3',
  vo_round1: 'vo_round1.mp3',
  vo_round2: 'vo_round2.mp3',
  vo_final: 'vo_final.mp3',
  vo_fight: 'vo_fight.mp3',
  vo_ko: 'vo_ko.mp3',
  vo_perfect: 'vo_perfect.mp3',
  vo_youwin: 'vo_youwin.mp3',
  vo_choose: 'vo_choose.mp3',
  vo_transform: 'vo_transform.mp3',
  vo_ultimate: 'vo_ultimate.mp3',
};

// ---- v2 voice packs: assets/audio/vo_{id}_{kind}.mp3, lazy-loaded per fighter+kind. ----
// kinds: grunt1 | grunt2 | hurt | charge | transform. Separate from FILES/loadBuffer above
// (that map is a fixed dict; voice packs are 8 fighters x 5 kinds = 40 possible files, most
// of which may not exist yet - each 404 is cached as null so it is never re-fetched).
const VOICE_KINDS = ['grunt1', 'grunt2', 'hurt', 'charge', 'transform', 'ko'];
const voiceBufferCache = new Map(); // "id:kind" -> Promise<AudioBuffer|null>
const lastVoiceGruntAt = new Map(); // id -> ms timestamp of last grunt1/grunt2/charge/transform
const lastVoiceHurtAt = new Map();  // id -> ms timestamp of last hurt
const VOICE_RATE_LIMIT_MS = 180;

function loadVoiceBuffer(id, kind) {
  const key = id + ':' + kind;
  if (voiceBufferCache.has(key)) return voiceBufferCache.get(key);
  if (!ctx || VOICE_KINDS.indexOf(kind) === -1) {
    const p = Promise.resolve(null);
    voiceBufferCache.set(key, p);
    return p;
  }
  const p = fetch(BASE + 'vo_' + id + '_' + kind + '.mp3')
    .then((res) => {
      if (!res.ok) throw new Error('voice fetch failed: ' + key);
      return res.arrayBuffer();
    })
    .then((arr) => ctx.decodeAudioData(arr))
    .catch(() => null); // fail-soft: voice packs may not exist yet, never retry
  voiceBufferCache.set(key, p);
  return p;
}

let ctx = null;
let musicGain = null;
let sfxGain = null;
let voGain = null;

let muted = false;
let musicVolTarget = 0.8;
let sfxVolTarget = 1.0;

let currentMusicName = null;
let currentMusicSrc = null;

// name -> Promise<AudioBuffer|null>  (null = failed to load, cached so we don't retry every call)
const bufferCache = new Map();

let pendingMusicName = null; // requested before init(); played once the context exists
let duckRestoreTimer = null;

function ensureGraph() {
  if (!ctx) return false;
  if (!musicGain) {
    musicGain = ctx.createGain();
    musicGain.gain.value = muted ? 0 : musicVolTarget;
    musicGain.connect(ctx.destination);
  }
  if (!sfxGain) {
    sfxGain = ctx.createGain();
    sfxGain.gain.value = muted ? 0 : sfxVolTarget;
    sfxGain.connect(ctx.destination);
  }
  if (!voGain) {
    voGain = ctx.createGain();
    voGain.gain.value = muted ? 0 : 1.0;
    voGain.connect(ctx.destination);
  }
  return true;
}

// v2.2: names not in the fixed FILES dict fall back to "<name>.mp3" by convention,
// so per-fighter cues (sfx_<id>_hit_l, sfx_<id>_ult, ...) load without a manifest
// entry. A 404 resolves to null (cached forever, never re-fetched or thrown) so the
// caller's opts.fallback can engage silently while assets are still missing.
function loadBuffer(name) {
  if (bufferCache.has(name)) return bufferCache.get(name);
  const file = FILES[name] || (name + '.mp3');
  if (!ctx) {
    const p = Promise.resolve(null);
    bufferCache.set(name, p);
    return p;
  }
  const p = fetch(BASE + file)
    .then((res) => {
      if (!res.ok) return null; // 404/miss: resolve null (do not throw, do not retry)
      return res.arrayBuffer().then((arr) => ctx.decodeAudioData(arr));
    })
    .catch(() => null);
  bufferCache.set(name, p);
  return p;
}

export const audio = {
  init() {
    if (!ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
      } catch (err) {
        console.warn('[audio] WebAudio unavailable', err);
        return;
      }
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    ensureGraph();
    if (pendingMusicName) {
      const n = pendingMusicName;
      pendingMusicName = null;
      this.music(n);
    }
  },

  music(name) {
    if (!ctx || !ensureGraph()) {
      pendingMusicName = name;
      return;
    }
    if (currentMusicName === name && currentMusicSrc) return; // already playing this track
    this.stopMusic();
    currentMusicName = name;
    loadBuffer(name).then((buf) => {
      if (!buf || currentMusicName !== name || !ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(musicGain);
      src.start(0);
      currentMusicSrc = src;
    });
  },

  stopMusic() {
    if (currentMusicSrc) {
      try { currentMusicSrc.stop(0); } catch (_e) {}
      try { currentMusicSrc.disconnect(); } catch (_e) {}
    }
    currentMusicSrc = null;
    currentMusicName = null;
  },

  // opts: legacy number = gain (0..1 multiplier on the sfx bus), OR an object
  // {gain, rate, fallback}. rate sets source.playbackRate (pitch/speed); fallback is
  // a buffer name played instead when `name` 404s (per-fighter cue -> shared file).
  // v2.2: sfx('sfx_<id>_hit_h', {fallback:'sfx_hit_h', rate:1.1}).
  sfx(name, opts) {
    if (!ctx || !ensureGraph()) return;
    let gain = 1, rate = 1, fallback = null;
    if (typeof opts === 'number') gain = opts;
    else if (opts && typeof opts === 'object') {
      if (typeof opts.gain === 'number') gain = opts.gain;
      if (typeof opts.rate === 'number') rate = opts.rate;
      if (opts.fallback) fallback = opts.fallback;
    }
    loadBuffer(name).then((buf) => {
      if (!ctx) return;
      if (!buf) {
        // named cue missing: play the shared fallback once (no nested fallback -> no loop)
        if (fallback) this.sfx(fallback, { gain, rate });
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (rate !== 1) { try { src.playbackRate.value = rate; } catch (_e) {} }
      if (gain !== 1) {
        const g = ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1, gain));
        src.connect(g);
        g.connect(sfxGain);
      } else {
        src.connect(sfxGain);
      }
      src.start(0);
    });
  },

  // v2 voice packs: per-fighter grunt/hurt/charge/transform lines.
  // Rate-limited per fighter (>=180ms between calls) so a flurry of hits doesn't
  // stack overlapping voice lines; 'hurt' has priority and always interrupts/bypasses
  // the grunt-side limiter (it uses its own independent timestamp).
  voice(id, kind) {
    if (!ctx || !ensureGraph() || !id || VOICE_KINDS.indexOf(kind) === -1) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // 'ko' is a decisive one-shot round-ending cry: bypass the grunt/hurt limiter so
    // it always plays, and pre-empt any pending grunt cooldown for this fighter.
    if (kind === 'ko') {
      lastVoiceGruntAt.set(id, now);
      lastVoiceHurtAt.set(id, now);
    } else if (kind === 'hurt') {
      const last = lastVoiceHurtAt.get(id) || -Infinity;
      if (now - last < VOICE_RATE_LIMIT_MS) return;
      lastVoiceHurtAt.set(id, now);
      // hurt interrupts/pre-empts a pending grunt cooldown for the same fighter
      lastVoiceGruntAt.set(id, now);
    } else {
      const last = lastVoiceGruntAt.get(id) || -Infinity;
      if (now - last < VOICE_RATE_LIMIT_MS) return;
      lastVoiceGruntAt.set(id, now);
    }
    loadVoiceBuffer(id, kind).then((buf) => {
      if (!buf || !ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(voGain);
      src.start(0);
    });
  },

  vo(name) {
    if (!ctx || !ensureGraph()) return;
    loadBuffer(name).then((buf) => {
      if (!buf || !ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(voGain);
      src.start(0);
      const ms = Math.max(200, (buf.duration || 1) * 1000 + 150);
      this.duck(ms);
    });
  },

  // Tokenbrawl embed: one switch over all three buses. Targets are kept so an
  // unmute restores whatever the options screen had set.
  mute(flag) {
    muted = !!flag;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (musicGain) musicGain.gain.setTargetAtTime(muted ? 0 : musicVolTarget, now, 0.03);
    if (sfxGain) sfxGain.gain.setTargetAtTime(muted ? 0 : sfxVolTarget, now, 0.03);
    if (voGain) voGain.gain.setTargetAtTime(muted ? 0 : 1.0, now, 0.03);
  },

  setVol(music, sfx) {
    if (typeof music === 'number') {
      musicVolTarget = Math.max(0, Math.min(1, music));
      if (musicGain && ctx && !muted) musicGain.gain.setTargetAtTime(musicVolTarget, ctx.currentTime, 0.05);
    }
    if (typeof sfx === 'number') {
      sfxVolTarget = Math.max(0, Math.min(1, sfx));
      if (sfxGain && ctx && !muted) sfxGain.gain.setTargetAtTime(sfxVolTarget, ctx.currentTime, 0.05);
    }
  },

  duck(ms) {
    if (!ctx || !musicGain) return;
    const now = ctx.currentTime;
    const duckedLevel = muted ? 0 : musicVolTarget * 0.25;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setTargetAtTime(duckedLevel, now, 0.05);
    if (duckRestoreTimer) clearTimeout(duckRestoreTimer);
    duckRestoreTimer = setTimeout(() => {
      if (musicGain && ctx) {
        musicGain.gain.setTargetAtTime(muted ? 0 : musicVolTarget, ctx.currentTime, 0.25);
      }
    }, Math.max(0, ms));
  },
};
