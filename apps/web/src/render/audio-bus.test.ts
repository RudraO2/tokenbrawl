import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BASIS_POINTS_FULL } from '../replay/film';
import { DEFAULT_AUDIO_TUNING, type AudioCue } from './audio';
import {
  createAudioBus,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type AudioFetchResponse,
  type GainNodeLike,
} from './audio-bus';

/**
 * Story 9.6, the host half.
 *
 * A fake `AudioContext` that records the graph, because the two things worth
 * asserting here are both structural: that each cue reaches the `GainNode` for
 * its own bus and that node reaches `destination`, and that every failure --
 * a missing constructor, a 404, a decode rejection, a `resume()` that rejects --
 * is a silence rather than a throw.
 *
 * No real WebAudio, no jsdom, no new dependency. The fake satisfies the
 * structural types `audio-bus.ts` declares, which is the same trick `main.ts`'s
 * `CanvasSurface` makes possible for the canvas.
 */

const DESTINATION = { id: 'destination' };

/**
 * Wraps a prepared fake as a constructor.
 *
 * A `function` rather than an arrow, and that is not cosmetic: an arrow function
 * is not constructible, so `new (() => context)()` is a `TypeError` and every
 * case here would have exercised the constructor-threw branch instead of the
 * one it names.
 */
function asConstructor(build: () => AudioContextLike): new () => AudioContextLike {
  return function AudioContextFake(this: unknown): AudioContextLike {
    return build();
  } as unknown as new () => AudioContextLike;
}

interface FakeGain extends GainNodeLike {
  readonly id: string;
  readonly connectedTo: () => readonly unknown[];
}

interface FakeSource extends AudioBufferSourceLike {
  readonly connectedTo: () => readonly unknown[];
  readonly started: () => readonly number[];
  readonly stopped: () => readonly number[];
  readonly disconnects: () => number;
}

interface FakeContext extends AudioContextLike {
  readonly gains: () => readonly FakeGain[];
  readonly sources: () => readonly FakeSource[];
  readonly resumes: () => number;
}

function createFakeContext(options: {
  readonly state?: 'suspended' | 'running' | 'interrupted' | 'closed';
  readonly decode?: (data: ArrayBuffer) => Promise<unknown>;
  readonly resume?: () => Promise<void>;
  readonly stopThrows?: boolean;
} = {}): FakeContext {
  const gains: FakeGain[] = [];
  const sources: FakeSource[] = [];
  const counted = { resumes: 0 };

  return {
    destination: DESTINATION,
    state: options.state,
    createGain: (): FakeGain => {
      const connections: unknown[] = [];
      const node: FakeGain = {
        id: `gain-${String(gains.length)}`,
        gain: { value: 1 },
        connect: (destination: unknown) => connections.push(destination),
        connectedTo: () => connections,
      };
      gains.push(node);
      return node;
    },
    createBufferSource: (): FakeSource => {
      const connections: unknown[] = [];
      const starts: number[] = [];
      const stops: number[] = [];
      const counted = { disconnects: 0 };
      const node: FakeSource = {
        buffer: null,
        loop: false,
        connect: (destination: unknown) => connections.push(destination),
        start: (when: number) => starts.push(when),
        stop: (when: number) => {
          stops.push(when);
          if (options.stopThrows === true) {
            // A source that already ended throws in some engines. One bad
            // source must not leave the rest of a stale Match playing.
            throw new Error('already ended');
          }
        },
        disconnect: () => {
          counted.disconnects += 1;
        },
        connectedTo: () => connections,
        started: () => starts,
        stopped: () => stops,
        disconnects: () => counted.disconnects,
      };
      sources.push(node);
      return node;
    },
    decodeAudioData: options.decode ?? ((): Promise<unknown> => Promise.resolve({ decoded: true })),
    resume:
      options.resume ??
      ((): Promise<void> => {
        counted.resumes += 1;
        return Promise.resolve();
      }),
    gains: () => gains,
    sources: () => sources,
    resumes: () => counted.resumes,
  };
}

/** A fetch that always succeeds, counting how many times each URL was asked for. */
function createCountingFetch(
  respond: (url: string) => AudioFetchResponse | Promise<AudioFetchResponse>,
): ((url: string) => Promise<AudioFetchResponse>) & { readonly urls: () => readonly string[] } {
  const urls: string[] = [];
  const fetchAudio = async (url: string): Promise<AudioFetchResponse> => {
    urls.push(url);
    return respond(url);
  };
  return Object.assign(fetchAudio, { urls: () => urls });
}

function okResponse(): AudioFetchResponse {
  return {
    ok: true,
    status: 200,
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(8)),
  };
}

function notFound(): AudioFetchResponse {
  return {
    ok: false,
    status: 404,
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.reject(new Error('no body')),
  };
}

const CUES: Readonly<Record<'music' | 'sfx' | 'voice', AudioCue>> = Object.freeze({
  music: Object.freeze({ bus: 'music', name: 'music_battle', loop: true }),
  sfx: Object.freeze({ bus: 'sfx', name: 'sfx_hit_l', loop: false }),
  voice: Object.freeze({ bus: 'voice', name: 'vo_ko', loop: false }),
});

/** Lets every queued microtask settle, since `play` deliberately hands back no promise. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    await Promise.resolve();
  }
}

describe('the three-bus graph (AC1)', () => {
  it('builds three independent gain nodes, each connected straight to destination', () => {
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });

    expect(sink).not.toBeNull();
    expect(context.gains()).toHaveLength(3);
    // Three distinct nodes, not one shared one -- and each reaches the output
    // itself rather than through another bus, which is what makes ducking the
    // music leave the SFX alone.
    expect(new Set(context.gains().map((node) => node.id)).size).toBe(3);
    for (const node of context.gains()) {
      expect(node.connectedTo()).toStrictEqual([DESTINATION]);
    }
  });

  it('routes each cue to the gain node for its own bus', async () => {
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });

    sink?.play(CUES.music);
    sink?.play(CUES.sfx);
    sink?.play(CUES.voice);
    await settle();

    const [music, sfx, voice] = context.gains();
    expect(context.sources()).toHaveLength(3);
    const routed = context.sources().map((source) => source.connectedTo()[0]);
    expect(routed).toStrictEqual([music, sfx, voice]);
    // And every source starts at `0`. There is no time computed from anything:
    // `ctx.currentTime` is a wall clock and this layer does not read one.
    for (const source of context.sources()) {
      expect(source.started()).toStrictEqual([0]);
    }
    // Only the music bed loops.
    expect(context.sources().map((source) => source.loop)).toStrictEqual([true, false, false]);
  });

  it('moves one bus without touching the other two', () => {
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });
    const [music, sfx, voice] = context.gains();

    sink?.setGains(8_000, BASIS_POINTS_FULL, BASIS_POINTS_FULL);
    expect(music.gain.value).toBeCloseTo(0.8, 10);
    expect(sfx.gain.value).toBe(1);
    expect(voice.gain.value).toBe(1);

    // The duck: music down, the other two exactly where they were.
    sink?.setGains(2_500, BASIS_POINTS_FULL, BASIS_POINTS_FULL);
    expect(music.gain.value).toBeCloseTo(0.25, 10);
    expect(sfx.gain.value).toBe(1);
    expect(voice.gain.value).toBe(1);
  });

  it('clamps a nonsensical gain rather than handing WebAudio a negative or a NaN', () => {
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });
    const [music, sfx, voice] = context.gains();

    sink?.setGains(-5_000, 999_999, Number.NaN);
    expect(music.gain.value).toBe(0);
    expect(sfx.gain.value).toBe(1);
    expect(voice.gain.value).toBe(0);
  });
});

describe('stopAll, because the sink outlives any one Match', () => {
  it('stops and disconnects every source it started, so a re-mount cannot stack a second bed', async () => {
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });
    sink?.play(CUES.music);
    sink?.play(CUES.sfx);
    await settle();
    expect(context.sources()).toHaveLength(2);

    sink?.stopAll();

    for (const source of context.sources()) {
      expect(source.stopped()).toStrictEqual([0]);
      expect(source.disconnects()).toBe(1);
    }

    // And the set is emptied: a second `stopAll` must not re-stop a source that
    // is already gone, which is what throws in a real engine.
    sink?.stopAll();
    for (const source of context.sources()) {
      expect(source.stopped()).toStrictEqual([0]);
    }
  });

  it('keeps stopping the rest when one source throws on stop', async () => {
    const context = createFakeContext({ stopThrows: true });
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });
    sink?.play(CUES.music);
    sink?.play(CUES.sfx);
    await settle();

    expect(() => sink?.stopAll()).not.toThrow();
    expect(context.sources().every((source) => source.stopped().length === 1)).toBe(true);
  });

  it('plays again after a stopAll: the sink is reusable, not spent', async () => {
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });
    sink?.play(CUES.music);
    await settle();
    sink?.stopAll();
    sink?.play(CUES.music);
    await settle();

    expect(context.sources()).toHaveLength(2);
    expect(context.sources()[1].started()).toStrictEqual([0]);
  });
});

describe('fail-soft in every direction (AC2)', () => {
  it('returns null when the environment has no AudioContext at all', () => {
    expect(createAudioBus({})).toBeNull();
    expect(createAudioBus({ fetch: createCountingFetch(okResponse) })).toBeNull();
  });

  it('returns null rather than throwing when the constructor throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sink = createAudioBus({
      AudioContext: asConstructor(() => {
        throw new Error('audio is blocked in this context');
      }),
    });

    expect(sink).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is silent and non-throwing when the file 404s, and never re-fetches it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = createFakeContext();
    const fetchAudio = createCountingFetch(notFound);
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: fetchAudio,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => sink?.play(CUES.sfx)).not.toThrow();
      await settle();
    }

    // Nothing played, and the missing name was asked for exactly once. Without
    // the absent-cache, one missing SFX file is one failed request per hit for
    // the length of a Match.
    expect(context.sources()).toHaveLength(0);
    expect(fetchAudio.urls()).toStrictEqual(['/audio/sfx_hit_l.mp3']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is silent and non-throwing when decoding rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = createFakeContext({
      decode: (): Promise<unknown> => Promise.reject(new Error('unsupported codec')),
    });
    const fetchAudio = createCountingFetch(okResponse);
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: fetchAudio,
    });

    sink?.play(CUES.voice);
    sink?.play(CUES.voice);
    await settle();

    expect(context.sources()).toHaveLength(0);
    expect(fetchAudio.urls()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is silent and non-throwing when the environment has no fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
    });

    // The graph still exists -- gains are still applied, and a page with a
    // context but no fetch is silent rather than broken.
    expect(sink).not.toBeNull();
    sink?.setGains(8_000, BASIS_POINTS_FULL, BASIS_POINTS_FULL);
    sink?.play(CUES.music);
    await settle();

    expect(context.sources()).toHaveLength(0);
    expect(context.gains()[0].gain.value).toBeCloseTo(0.8, 10);
    warn.mockRestore();
  });

  it('swallows a rejected resume() rather than turning a button press into an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = createFakeContext({
      state: 'suspended',
      resume: (): Promise<void> => Promise.reject(new Error('the tab went away')),
    });
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch(okResponse),
    });

    expect(() => sink?.unlock()).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resumes a suspended context and leaves a running one alone', async () => {
    const suspended = createFakeContext({ state: 'suspended' });
    const running = createFakeContext({ state: 'running' });

    createAudioBus({
      AudioContext: asConstructor(() => suspended),
    })?.unlock();
    createAudioBus({
      AudioContext: asConstructor(() => running),
    })?.unlock();
    await settle();

    expect(suspended.resumes()).toBe(1);
    expect(running.resumes()).toBe(0);
  });

  it('resumes an interrupted context too, not the one literal state', async () => {
    // iOS Safari parks a context in `interrupted` after a phone call or an app
    // switch. A check for `suspended` alone left the page silent for the rest
    // of the session with no way back.
    const interrupted = createFakeContext({ state: 'interrupted' });
    createAudioBus({ AudioContext: asConstructor(() => interrupted) })?.unlock();
    await settle();
    expect(interrupted.resumes()).toBe(1);
  });

  it('keeps playing after a failed cue: one bad name does not poison the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = createFakeContext();
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: createCountingFetch((url) => (url.includes('vo_ko') ? notFound() : okResponse())),
    });

    sink?.play(CUES.voice);
    sink?.play(CUES.sfx);
    sink?.play(CUES.music);
    await settle();

    // The two good cues played; the missing one did not, and did not take them
    // with it.
    expect(context.sources()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('the name → URL convention stays same-origin', () => {
  it('resolves a cue name under /audio/ and nowhere else', async () => {
    const context = createFakeContext();
    const fetchAudio = createCountingFetch(okResponse);
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: fetchAudio,
    });

    sink?.play(CUES.music);
    sink?.play(CUES.sfx);
    await settle();

    for (const url of fetchAudio.urls()) {
      // Rooted and same-origin: the site must render identically offline, and
      // `style-discipline.test.ts` sweeps the source for the other case.
      expect(url.startsWith('/audio/')).toBe(true);
      expect(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)).toBe(false);
    }
    expect(fetchAudio.urls()).toStrictEqual(['/audio/music_battle.mp3', '/audio/sfx_hit_l.mp3']);
  });

  it('encodes a name that would otherwise escape the directory or the origin', async () => {
    // The tuning table is advertised as hand-editable by a later story, so a
    // name is not a guaranteed-safe identifier forever. `//host/x` is
    // protocol-relative and would fetch from another origin -- the exact shape
    // `resolveSidecarUrl` refuses in `startup.ts`.
    const context = createFakeContext();
    const fetchAudio = createCountingFetch(okResponse);
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: fetchAudio,
    });

    sink?.play({ bus: 'sfx', name: '../../evil', loop: false });
    sink?.play({ bus: 'sfx', name: '/evil.example/x', loop: false });
    await settle();

    for (const url of fetchAudio.urls()) {
      expect(url.startsWith('/audio/')).toBe(true);
      // The dots may survive encoding -- `..%2F..%2Fevil.mp3` is a single
      // filename, not two levels up. What may not survive is a separator: with
      // no unencoded `/` after the prefix there is no path to traverse and no
      // authority to redirect to.
      expect(url.slice('/audio/'.length).includes('/')).toBe(false);
    }
  });

  it('resolves every name the shipped tuning asks for to a file that is actually on disk', async () => {
    // Found by Story 11.5's review. `docs-discipline.test.ts` sweeps the other
    // direction -- every `.mp3` in `public/audio/` has a provenance row -- so a
    // *file* cannot arrive unrecorded. Nothing swept this way, and a name is
    // the half a story actually edits: `ultimateVoice: 'vo_ultimte'` would have
    // shipped a green suite, one `console.warn` nobody reads and a silent
    // Ultimate, which is the exact defect this story exists to close.
    //
    // The path is built by the real `defaultUrlFor`, by fetching through the
    // real sink, rather than by writing `/audio/${name}.mp3` out again here: a
    // convention asserted against a copy of itself asserts nothing.
    const context = createFakeContext();
    const fetchAudio = createCountingFetch(okResponse);
    const sink = createAudioBus({
      AudioContext: asConstructor(() => context),
      fetch: fetchAudio,
    });

    const names = [
      DEFAULT_AUDIO_TUNING.music.name,
      ...Object.values(DEFAULT_AUDIO_TUNING.sfx),
      ...Object.values(DEFAULT_AUDIO_TUNING.voice),
      DEFAULT_AUDIO_TUNING.ultimate,
      DEFAULT_AUDIO_TUNING.ultimateVoice,
    ];
    for (const name of names) {
      sink?.play({ bus: 'sfx', name, loop: false });
    }
    await settle();

    const urls = fetchAudio.urls();
    expect(urls).toHaveLength(names.length);
    const missing = urls.filter((url) => !existsSync(join(process.cwd(), 'public', url)));
    expect(missing).toStrictEqual([]);
  });
});
