// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = readFileSync(join(appRoot, 'index.html'), 'utf8');
const manifest = JSON.parse(
  readFileSync(join(appRoot, 'public', 'manifest.webmanifest'), 'utf8'),
) as {
  readonly name?: string;
  readonly start_url?: string;
  readonly display?: string;
  readonly icons?: readonly { readonly src?: string; readonly sizes?: string; readonly type?: string }[];
};

function pngDimensions(path: string): readonly [number, number] {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('the installable web app', () => {
  it('links its manifest from the application document', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/nix-icon-192.png" />');
  });

  it('declares the promoted-installation fields and exact raster sizes browsers require', () => {
    expect(manifest).toMatchObject({ name: 'Nix', start_url: '/', display: 'standalone' });
    const icons = manifest.icons ?? [];
    for (const size of [192, 512]) {
      const dimension = String(size);
      const icon = icons.find((candidate) => candidate.sizes === `${dimension}x${dimension}`);
      expect(icon).toMatchObject({ type: 'image/png' });
      expect(icon?.src).toMatch(/^\/[a-z0-9-]+\.png$/u);
      expect(pngDimensions(join(appRoot, 'public', icon?.src ?? 'missing'))).toEqual([size, size]);
    }
  });
});
