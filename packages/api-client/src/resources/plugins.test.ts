import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../testing/server.js';
import {
  beginComponentUpload,
  list,
  putComponent,
  register,
  replaceCapabilities,
  setEnabled,
  type RegisterPluginComponentInput,
} from './plugins.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'A'.repeat(64);
const registration: RegisterPluginComponentInput = {
  publisherId: 'example.plugins',
  id: 'example.plugins/planner',
  version: '1.0.0',
  objectKey: `plugins/components/${WORKSPACE_ID}/planner.wasm`,
  sha256: DIGEST,
  byteLength: 8,
  publicKey: 'A'.repeat(44),
  signature: 'B'.repeat(88),
};

describe('the plugins resource', () => {
  it('keeps catalog and trust mutations behind workspace-scoped Core routes', () => {
    expect(list(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/plugins`,
      cacheKey: ['plugins', WORKSPACE_ID],
    });
    expect(beginComponentUpload(WORKSPACE_ID, registration)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/plugins/components/upload`,
      method: 'POST',
    });
    expect(register(WORKSPACE_ID, registration)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/plugins`,
      method: 'POST',
    });
    expect(setEnabled(WORKSPACE_ID, INSTALLATION_ID, true)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/plugins/${INSTALLATION_ID}/enabled`,
      method: 'PUT',
    });
    expect(
      replaceCapabilities(WORKSPACE_ID, INSTALLATION_ID, ['items.read-metadata']),
    ).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/plugins/${INSTALLATION_ID}/capabilities`,
      method: 'PUT',
    });
  });

  it('uploads immutable bytes with every signed capability header', async () => {
    const received = vi.fn();
    server.use(
      http.put('https://objects.example.test/component.wasm', async ({ request }) => {
        received({
          ifNoneMatch: request.headers.get('if-none-match'),
          checksum: request.headers.get('x-amz-checksum-sha256'),
          contentType: request.headers.get('content-type'),
          body: new Uint8Array(await request.arrayBuffer()),
        });
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await putComponent(
      {
        objectKey: 'plugins/components/example.wasm',
        uploadUrl: 'https://objects.example.test/component.wasm',
        expiresAt: '2999-09-01T10:00:00+00:00',
        ifNoneMatch: '*',
        xAmzChecksumSha256: 'Q'.repeat(44),
      },
      new Blob([new Uint8Array([0, 97, 115, 109])]),
    );

    expect(received).toHaveBeenCalledWith({
      ifNoneMatch: '*',
      checksum: 'Q'.repeat(44),
      contentType: 'application/wasm',
      body: new Uint8Array([0, 97, 115, 109]),
    });
  });

  it('refuses an insecure component capability before sending bytes', async () => {
    await expect(
      putComponent(
        {
          objectKey: 'plugins/components/example.wasm',
          uploadUrl: 'http://objects.example.test/component.wasm',
          expiresAt: '2999-09-01T10:00:00+00:00',
          ifNoneMatch: '*',
          xAmzChecksumSha256: 'Q'.repeat(44),
        },
        new Blob([new Uint8Array([0])]),
      ),
    ).rejects.toThrow(/HTTPS/);
  });
});
