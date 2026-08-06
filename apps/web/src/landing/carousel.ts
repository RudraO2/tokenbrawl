import { escapeHtml } from '../main';

/**
 * Story 9.8: the marketing clip carousel.
 *
 * `public/marketing-clips/manifest.json` is this component's one source of
 * truth, in the same shape `spectate/manifest.ts` established for
 * `public/replays/manifest.json` (AD-17: the carousel is that same
 * manifest-walk principle, applied to a flat clip list instead of a Match
 * loop order). This module owns fetching and structurally validating that
 * document, and rendering whatever clips it names as real `<video>`
 * elements -- never a canvas, never a live simulation of a Command Log. Each
 * clip loops itself natively (the `loop` attribute), so there is no
 * JS-driven advance timer here and nothing on this file's own path reads a
 * wall clock (INV-3's sweep still covers `apps/web` end to end).
 *
 * The manifest is committed with an empty clip list today: the video files
 * themselves are operator-owed (manually recorded gameplay footage), not
 * agent-producible. An empty manifest is not an error -- it is the expected
 * state at merge time -- so both the validator and the renderer treat zero
 * clips as a normal, clean empty state rather than throwing.
 */

export interface ClipManifestEntry {
  readonly id: string;
  readonly src: string;
  /** Seconds. Informational only -- playback length comes from the file itself. */
  readonly duration: number;
  readonly poster?: string;
}

export interface ClipManifest {
  readonly schemaVersion: string;
  readonly clips: readonly ClipManifestEntry[];
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface FetchLike {
  (url: string): Promise<FetchResponse>;
}

function fail(message: string): never {
  throw new Error(`Invalid marketing clip manifest: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where}.${field} must be a non-empty string.`);
  }
  return value as string;
}

function requirePositiveNumber(source: Record<string, unknown>, field: string, where: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${where}.${field} must be a positive number.`);
  }
  return value as number;
}

function parseClip(raw: unknown, index: number): ClipManifestEntry {
  const where = `clips[${String(index)}]`;
  const source = asRecord(raw, where);
  const id = requireString(source, 'id', where);
  const src = requireString(source, 'src', where);
  const duration = requirePositiveNumber(source, 'duration', where);

  const posterRaw = source['poster'];
  if (posterRaw !== undefined && (typeof posterRaw !== 'string' || posterRaw.trim() === '')) {
    fail(`${where}.poster must be a non-empty string when present.`);
  }

  const entry: ClipManifestEntry = {
    id,
    src,
    duration,
    ...(posterRaw === undefined ? {} : { poster: posterRaw as string }),
  };
  return Object.freeze(entry);
}

/**
 * Structurally validates a fetched manifest document.
 *
 * An empty `clips` array is accepted -- unlike `spectate/manifest.ts`'s
 * Spectate manifest, which needs at least one entry to have anything to
 * loop, the marketing carousel's whole point at merge time is that it has
 * zero committed clips and still renders cleanly.
 */
export function validateClipManifest(candidate: unknown): ClipManifest {
  const source = asRecord(candidate, 'the manifest');
  const schemaVersion = requireString(source, 'schemaVersion', 'the manifest');

  const clipsRaw = source['clips'];
  if (!Array.isArray(clipsRaw)) {
    fail('clips must be an array.');
  }

  const clips = clipsRaw.map((raw, index) => parseClip(raw, index));

  const seenIds = new Set<string>();
  for (const clip of clips) {
    if (seenIds.has(clip.id)) {
      fail(`clips contains a duplicate id "${clip.id}".`);
    }
    seenIds.add(clip.id);
  }

  const manifest: ClipManifest = {
    schemaVersion,
    clips: Object.freeze(clips),
  };
  return Object.freeze(manifest);
}

/** Same-origin, mirroring `spectate/manifest.ts`'s `SPECTATE_MANIFEST_URL`. */
export const CLIP_MANIFEST_URL = '/marketing-clips/manifest.json';

export async function fetchClipManifest(fetchImpl: FetchLike): Promise<ClipManifest> {
  const response = await fetchImpl(CLIP_MANIFEST_URL);
  if (!response.ok) {
    throw new Error(`could not load ${CLIP_MANIFEST_URL} (HTTP ${String(response.status)})`);
  }
  return validateClipManifest(await response.json());
}

export interface CarouselHost {
  innerHTML: string;
}

export interface CarouselDeps {
  readonly fetch: FetchLike;
  /** Injectable so a test can supply a manifest with no network at all. */
  readonly loadManifest?: (fetchImpl: FetchLike) => Promise<ClipManifest>;
  /** Reported, never thrown -- a bad or missing manifest must not break the page around it. */
  readonly onWarning?: (message: string) => void;
}

export interface CarouselPanel {
  readonly clipCount: () => number;
}

/** One `<video>` per clip, muted and looping natively -- never a JS advance timer. */
function clipMarkup(clip: ClipManifestEntry): string {
  const posterAttr = clip.poster === undefined ? '' : ` poster="${escapeHtml(clip.poster)}"`;
  return `
    <li class="tb-carousel-item" data-carousel-clip="${escapeHtml(clip.id)}">
      <video
        class="tb-carousel-video"
        src="${escapeHtml(clip.src)}"
        autoplay
        muted
        loop
        playsinline${posterAttr}
      ></video>
    </li>
  `;
}

/**
 * The carousel's markup. Exported so the shell can be asserted with no DOM,
 * in the same spirit as `spectateMarkup`/`arcadeMarkup`.
 *
 * Renders the empty state -- a plain message, no `<video>`, no canvas -- when
 * `clips` is empty, which is the expected state until an operator commits
 * real footage.
 */
export function carouselMarkup(clips: readonly ClipManifestEntry[] = []): string {
  if (clips.length === 0) {
    return `
      <p class="tb-carousel-empty" data-carousel-empty>
        Fight clips are on the way -- check back soon for a look at Tokenbrawl in motion.
      </p>
    `;
  }
  return `<ul class="tb-carousel-list" data-carousel-list>${clips.map(clipMarkup).join('')}</ul>`;
}

/**
 * Mounts the carousel and returns immediately; the manifest fetch happens in
 * the background, the same critical-path discipline `spectate/panel.ts`
 * follows -- a slow or missing manifest must not block the rest of the page.
 */
export function mountCarousel(host: CarouselHost, deps: CarouselDeps): CarouselPanel {
  host.innerHTML = carouselMarkup();

  const state: { clips: readonly ClipManifestEntry[] } = { clips: [] };

  const loadManifest = deps.loadManifest ?? fetchClipManifest;

  void (async (): Promise<void> => {
    try {
      const manifest = await loadManifest(deps.fetch);
      state.clips = manifest.clips;
      host.innerHTML = carouselMarkup(manifest.clips);
    } catch (error) {
      // Fail-soft: an unreadable manifest leaves the carousel's already-rendered
      // empty state on screen rather than crashing the landing page around it.
      deps.onWarning?.(
        `Marketing clips unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  return Object.freeze({
    clipCount: (): number => state.clips.length,
  });
}
