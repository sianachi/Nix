// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import config from '../../../vite.config';

interface GenerateBundlePlugin {
  readonly name: string;
  readonly generateBundle: (
    this: { emitFile: (asset: { fileName: string; source: string }) => void },
    options: unknown,
    bundle: Record<string, unknown>,
  ) => Promise<void>;
}

function findPwaAssetsPlugin(): GenerateBundlePlugin {
  const plugins = (config.plugins ?? []).flat() as Plugin[];
  const plugin = plugins.find((candidate) => candidate.name === 'nix-pwa-assets');
  if (plugin === undefined || typeof plugin.generateBundle !== 'function') {
    throw new Error('The nix-pwa-assets plugin is missing or lost its generateBundle hook.');
  }
  return plugin as unknown as GenerateBundlePlugin;
}

/**
 * The build-time transform in `vite.config.ts`'s `nix-pwa-assets` plugin rewrites three exact
 * literals in `public/service-worker.js` (the version string and the two static asset arrays) and
 * ships the rest of the file untouched. This runs that transform for real - against the real
 * `service-worker.js` and `offline.html` on disk - and asserts both halves of that contract: the
 * literals actually change, and the push/notificationclick/pushsubscriptionchange handlers this
 * lane added survive the rewrite intact, since a regex `.replace` anywhere else in the file would
 * silently corrupt them.
 */
describe('the PWA asset build transform', () => {
  it('rewrites the version and asset lists while keeping the push handlers intact', async () => {
    const plugin = findPwaAssetsPlugin();
    const emitted: Record<string, string> = {};
    const context = {
      emitFile: (asset: { fileName: string; source: string }) => {
        emitted[asset.fileName] = asset.source;
      },
    };

    await plugin.generateBundle.call(
      context,
      {},
      {
        // The shape the native-feel shell reads to find what an installed launch needs: the entry
        // chunk, the one application chunk it loads dynamically, and their stylesheets.
        'assets/index-abc123.js': {
          type: 'chunk',
          fileName: 'assets/index-abc123.js',
          isEntry: true,
          imports: [],
          dynamicImports: ['assets/app-abc123.js'],
          viteMetadata: { importedCss: new Set(['assets/index-abc123.css']) },
        },
        'assets/app-abc123.js': {
          type: 'chunk',
          fileName: 'assets/app-abc123.js',
          isEntry: false,
          imports: [],
          dynamicImports: [],
        },
        'assets/index-abc123.css': { type: 'asset' },
        'assets/vendor-def456.woff2': { type: 'asset' },
        'not-an-asset.txt': { type: 'asset' },
      },
    );

    const worker = emitted['service-worker.js'];
    expect(worker).toBeDefined();
    expect(worker).not.toContain("'nix-pwa-dev'");
    expect(worker).toMatch(/const VERSION = "nix-pwa-[0-9a-f]{16}";/);
    expect(worker).toContain('/assets/index-abc123.js');
    expect(worker).toContain('/assets/vendor-def456.woff2');
    expect(worker).toContain('const SHELL_ENTRY = "/assets/index-abc123.js";');

    for (const handler of ['push', 'notificationclick', 'pushsubscriptionchange']) {
      expect(worker).toContain(`addEventListener('${handler}'`);
    }
    expect(worker).toContain('self.registration.showNotification(title, options)');
    expect(worker).toContain('.open(PUSH_KEY_CACHE)');
  });
});
