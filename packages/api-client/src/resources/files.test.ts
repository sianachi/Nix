import { describe, expect, it } from 'vitest';

import { beginUpload, cancelUpload, completeUpload, downloadFile, fileByItem } from './files.js';

const ITEM = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE = 'a1000000-0000-4000-8000-000000000001';

describe('the files resource', () => {
  it('keeps file metadata and object capabilities behind Core', () => {
    expect(fileByItem(ITEM)).toMatchObject({
      path: `/api/v1/items/${ITEM}/file`,
      cacheKey: ['files', ITEM],
    });
    expect(downloadFile(ITEM)).toMatchObject({
      path: `/api/v1/items/${ITEM}/file/download`,
      query: { versionId: undefined, preview: false },
    });
    expect(
      beginUpload({
        workspaceId: WORKSPACE,
        parentId: null,
        fileName: 'photo.png',
        mediaType: 'image/png',
        byteLength: 12,
        idempotencyKey: 'one',
      }),
    ).toMatchObject({ path: '/api/v1/files/uploads', method: 'POST' });
  });

  it('completes only the exact object capability Core initiated', () => {
    const endpoint = completeUpload({
      id: ITEM,
      status: 'pending_upload',
      uploadUrl: 'https://objects.example/upload',
      capabilityExpiresAt: '2026-08-31T19:15:00+00:00',
      expiresAt: '2026-08-31T20:00:00+00:00',
      itemId: null,
      failureCode: null,
    });
    expect(endpoint.path).toBe(`/api/v1/files/uploads/${ITEM}/complete`);
    expect(endpoint.body).toBeUndefined();
    expect(endpoint.invalidates).toEqual([['items']]);
    expect(cancelUpload(ITEM)).toMatchObject({
      path: `/api/v1/files/uploads/${ITEM}`,
      method: 'DELETE',
    });
  });
});
