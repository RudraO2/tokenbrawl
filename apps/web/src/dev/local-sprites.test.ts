import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localSpritesPlugin } from './local-sprites';
import type { Plugin } from 'vite';

/**
 * Story 9.1 / AD-16.
 *
 * The plugin's whole job is to disappear when the developer's personal
 * `sprites.local.json` is absent -- true for CI, a reviewer, and every
 * machine other than the one that wrote it -- and to never let a malformed
 * file turn into a thrown error. This exercises the plugin factory directly
 * rather than spinning up a real Vite dev server: what matters is the object
 * `localSpritesPlugin()` returns, not the HTTP behaviour of a running server.
 *
 * The last block is the one that encodes AC5/"structurally cannot ship": Vite
 * only includes `apply: 'serve'` plugins in the dev server, never in
 * `vite build`, so asserting the literal string `'serve'` is asserting this
 * plugin cannot end up in `apps/web/dist`.
 */

describe('localSpritesPlugin', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tokenbrawl-local-sprites-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('no-ops when the config file is absent, without throwing', () => {
    const configPath = join(workspace, 'sprites.local.json');

    expect(() => localSpritesPlugin({ configPath })).not.toThrow();
    const plugin = localSpritesPlugin({ configPath });

    expect(plugin.apply).toBe('serve');
    expect(plugin.configureServer).toBeUndefined();
  });

  it('no-ops and warns when the config file is malformed JSON', () => {
    const configPath = join(workspace, 'sprites.local.json');
    writeFileSync(configPath, '{ this is not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let plugin: Plugin | undefined;
    expect(() => {
      plugin = localSpritesPlugin({ configPath });
    }).not.toThrow();

    expect(plugin?.apply).toBe('serve');
    expect(plugin?.configureServer).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('no-ops and warns when the config file is valid JSON but the wrong shape', () => {
    const configPath = join(workspace, 'sprites.local.json');
    writeFileSync(configPath, JSON.stringify({ notPacks: true }), 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const plugin = localSpritesPlugin({ configPath });

    expect(plugin.apply).toBe('serve');
    expect(plugin.configureServer).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('registers configureServer when the config is present and valid', () => {
    const configPath = join(workspace, 'sprites.local.json');
    writeFileSync(
      configPath,
      JSON.stringify({ packs: { hero: join(workspace, 'hero-assets') } }),
      'utf8',
    );

    const plugin = localSpritesPlugin({ configPath });

    expect(plugin.apply).toBe('serve');
    expect(typeof plugin.configureServer).toBe('function');
  });

  it('never returns apply other than "serve" -- the structural build-exclusion guarantee', () => {
    const configPath = join(workspace, 'sprites.local.json');

    // Absent config.
    expect(localSpritesPlugin({ configPath }).apply).toBe('serve');

    // Malformed config.
    writeFileSync(configPath, 'not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(localSpritesPlugin({ configPath }).apply).toBe('serve');
    warn.mockRestore();

    // Valid config.
    writeFileSync(configPath, JSON.stringify({ packs: { hero: workspace } }), 'utf8');
    const plugin = localSpritesPlugin({ configPath });
    expect(plugin.apply).toBe('serve');
    expect(plugin.apply).not.toBe('build');
    expect(plugin.apply).not.toBeUndefined();
  });
});
