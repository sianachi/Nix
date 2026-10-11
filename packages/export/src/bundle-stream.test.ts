import { describe, expect, it } from 'vitest';

import { BundleStreamError, readBundleStream } from './bundle-stream.js';

const manifest = JSON.stringify({ format: 'nix-archive', formatVersion: 1, items: [] });
const bundle = JSON.stringify({
  id: 'a',
  body: { schemaVersion: 1, prosemirror: { type: 'doc' } },
});

describe('readBundleStream', () => {
  it('reads the manifest, every bundle and the end marker', () => {
    const read = readBundleStream([manifest, bundle, '{"end":true,"items":1}', '']);
    expect(read.manifest.format).toBe('nix-archive');
    expect(read.bundles.map((entry) => entry.id)).toEqual(['a']);
  });

  it('refuses a stream that stops before its end marker', () => {
    expect(() => readBundleStream([manifest, bundle])).toThrow(BundleStreamError);
  });

  it('refuses a count that does not match', () => {
    expect(() => readBundleStream([manifest, bundle, '{"end":true,"items":2}'])).toThrow(
      /says it holds 2/,
    );
  });

  it('refuses a stream that does not open with a manifest', () => {
    expect(() => readBundleStream([bundle, '{"end":true,"items":0}'])).toThrow(/manifest/);
  });

  it('refuses lines after the end and lines that are not JSON', () => {
    expect(() => readBundleStream([manifest, '{"end":true,"items":0}', bundle])).toThrow(/after/);
    expect(() => readBundleStream([manifest, 'nope'])).toThrow(/not JSON/);
  });
});
