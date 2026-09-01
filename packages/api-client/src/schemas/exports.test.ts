import { describe, expect, it } from 'vitest';

import {
  exportDownloadCapabilitySchema,
  exportFormatCatalogSchema,
  exportSchema,
} from './exports.js';

const exportState = {
  id: 'a1111111-1111-4111-8111-111111111111',
  itemId: 'a2222222-2222-4222-8222-222222222222',
  workspaceId: 'a3333333-3333-4333-8333-333333333333',
  format: 'epub',
  scope: 'subtree',
  fileName: 'notes.epub',
  mediaType: 'application/epub+zip',
  status: 'completed',
  itemCount: '3',
  omittedCount: 1,
  byteLength: '128',
  sha256: 'a'.repeat(64),
  loss: ['Interactive views became static sections.'],
  omissions: ['One deleted item was omitted.'],
  failureCode: null,
  failureDetail: null,
  cancellationRequested: false,
  downloadReady: true,
  createdAt: '2026-09-01T09:00:00+00:00',
  completedAt: '2026-09-01T09:00:02+00:00',
  expiresAt: '2026-09-02T09:00:02+00:00',
};

describe('the export boundary schemas', () => {
  it('accepts a dynamically advertised format the client did not know at build time', () => {
    expect(
      exportFormatCatalogSchema.parse({
        formats: [
          {
            format: 'epub',
            label: 'EPUB',
            extension: 'epub',
            mediaType: 'application/epub+zip',
            lossless: false,
            declaredLoss: ['Interactive views become static sections.'],
          },
        ],
        observedAt: '2026-09-01T09:00:00+00:00',
      }).formats[0]?.format,
    ).toBe('epub');
  });

  it('accepts integer strings from the OpenAPI int64 contract but rejects ambiguous spellings', () => {
    expect(exportSchema.safeParse(exportState).success).toBe(true);
    expect(exportSchema.safeParse({ ...exportState, byteLength: '0128' }).success).toBe(false);
  });

  it('refuses a download capability without a complete SHA-256 digest', () => {
    expect(
      exportDownloadCapabilitySchema.safeParse({
        url: 'https://objects.example/result.epub',
        expiresAt: '2026-09-01T09:10:00+00:00',
        fileName: 'notes.epub',
        mediaType: 'application/epub+zip',
        byteLength: 128,
        sha256: 'not-a-digest',
      }).success,
    ).toBe(false);
  });
});
