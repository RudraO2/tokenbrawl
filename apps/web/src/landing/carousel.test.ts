import { describe, expect, it } from 'vitest';
import {
  CLIP_MANIFEST_URL,
  carouselMarkup,
  fetchClipManifest,
  mountCarousel,
  validateClipManifest,
  type CarouselHost,
  type ClipManifest,
  type FetchLike,
  type FetchResponse,
} from './carousel';

/** Structural fake, same discipline `spectate/panel.test.ts` uses. */
function createHost(): CarouselHost {
  const state = { html: '' };
  return {
    get innerHTML(): string {
      return state.html;
    },
    set innerHTML(value: string) {
      state.html = value;
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return { ok, status, json: async () => body };
}

describe('validateClipManifest', () => {
  it('accepts an empty clip list -- the expected merge-time state', () => {
    const manifest = validateClipManifest({ schemaVersion: '1.0.0', clips: [] });
    expect(manifest.clips).toHaveLength(0);
  });

  it('accepts a well-formed clip list', () => {
    const manifest = validateClipManifest({
      schemaVersion: '1.0.0',
      clips: [{ id: 'a', src: '/marketing-clips/a.mp4', duration: 8 }],
    });
    expect(manifest.clips).toHaveLength(1);
    expect(manifest.clips[0].id).toBe('a');
  });

  it('rejects a non-object document', () => {
    expect(() => validateClipManifest('not json')).toThrow(/must be an object/);
  });

  it('rejects a document whose clips field is not an array', () => {
    expect(() => validateClipManifest({ schemaVersion: '1.0.0', clips: 'nope' })).toThrow(/must be an array/);
  });

  it('rejects a malformed entry missing a required field', () => {
    expect(() =>
      validateClipManifest({ schemaVersion: '1.0.0', clips: [{ id: 'a' }] }),
    ).toThrow(/src/);
  });

  it('rejects a malformed entry with a non-positive duration', () => {
    expect(() =>
      validateClipManifest({
        schemaVersion: '1.0.0',
        clips: [{ id: 'a', src: '/x.mp4', duration: 0 }],
      }),
    ).toThrow(/duration/);
  });

  it('rejects a duplicate id', () => {
    expect(() =>
      validateClipManifest({
        schemaVersion: '1.0.0',
        clips: [
          { id: 'a', src: '/x.mp4', duration: 5 },
          { id: 'a', src: '/y.mp4', duration: 5 },
        ],
      }),
    ).toThrow(/duplicate id/);
  });

  it('accepts an optional poster and rejects an empty one', () => {
    const withPoster = validateClipManifest({
      schemaVersion: '1.0.0',
      clips: [{ id: 'a', src: '/x.mp4', duration: 5, poster: '/x.jpg' }],
    });
    expect(withPoster.clips[0].poster).toBe('/x.jpg');

    expect(() =>
      validateClipManifest({
        schemaVersion: '1.0.0',
        clips: [{ id: 'a', src: '/x.mp4', duration: 5, poster: '  ' }],
      }),
    ).toThrow(/poster/);
  });
});

describe('carouselMarkup', () => {
  it('renders a clean empty state with no <video> and no canvas', () => {
    const markup = carouselMarkup([]);
    expect(markup).toContain('data-carousel-empty');
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('<canvas');
  });

  it('renders exactly the given clips as <video> elements, in manifest order', () => {
    const manifest = validateClipManifest({
      schemaVersion: '1.0.0',
      clips: [
        { id: 'a', src: '/marketing-clips/a.mp4', duration: 5 },
        { id: 'b', src: '/marketing-clips/b.mp4', duration: 7 },
      ],
    });
    const markup = carouselMarkup(manifest.clips);
    const videoCount = markup.match(/<video/g)?.length ?? 0;
    expect(videoCount).toBe(2);
    expect(markup.indexOf('a.mp4')).toBeLessThan(markup.indexOf('b.mp4'));
    expect(markup).not.toContain('<canvas');
  });
});

describe('fetchClipManifest', () => {
  it(`fetches ${CLIP_MANIFEST_URL} and validates the result`, async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ schemaVersion: '1.0.0', clips: [] });
    const manifest = await fetchClipManifest(fetchImpl);
    expect(manifest.clips).toHaveLength(0);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, false, 404);
    await expect(fetchClipManifest(fetchImpl)).rejects.toThrow(/HTTP 404/);
  });
});

describe('mountCarousel', () => {
  it('renders the empty state synchronously and never throws for an empty manifest', () => {
    const host = createHost();
    const fetchImpl: FetchLike = async () => jsonResponse({ schemaVersion: '1.0.0', clips: [] });
    expect(() => mountCarousel(host, { fetch: fetchImpl })).not.toThrow();
    expect(host.innerHTML).toContain('data-carousel-empty');
  });

  it('mounts the fixed clip list from an injected manifest loader, with no extra network call', async () => {
    const host = createHost();
    let loadCalls = 0;
    const manifest: ClipManifest = validateClipManifest({
      schemaVersion: '1.0.0',
      clips: [{ id: 'a', src: '/marketing-clips/a.mp4', duration: 5 }],
    });
    const panel = mountCarousel(host, {
      fetch: async () => jsonResponse({}),
      loadManifest: async () => {
        loadCalls += 1;
        return manifest;
      },
    });
    // Let the fire-and-forget async mount settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(loadCalls).toBe(1);
    expect(panel.clipCount()).toBe(1);
    expect(host.innerHTML).toContain('a.mp4');
  });

  it('fails soft on a malformed manifest -- warns, keeps the empty state, never throws', async () => {
    const host = createHost();
    const warnings: string[] = [];
    expect(() =>
      mountCarousel(host, {
        fetch: async () => jsonResponse({}),
        loadManifest: async () => {
          throw new Error('boom');
        },
        onWarning: (message) => {
          warnings.push(message);
        },
      }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings.some((message) => message.includes('boom'))).toBe(true);
    expect(host.innerHTML).toContain('data-carousel-empty');
  });
});
