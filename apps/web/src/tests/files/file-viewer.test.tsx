import { render, screen } from '@testing-library/react';
import type { NixClient } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../files/file-viewer';

let client: NixClient;

vi.mock('../../api/api-client-provider', () => ({
  useApiClient: () => client,
}));

const ITEM = 'a1111111-1111-4111-8111-111111111111';
const VERSION = 'a2222222-2222-4222-8222-222222222222';

function record(previewable: boolean) {
  const current = {
    id: VERSION,
    version: 1,
    fileName: 'diagram.png',
    mediaType: 'image/png',
    byteLength: 7,
    sha256: '1'.repeat(64),
    previewable,
    pixelWidth: previewable ? 40 : null,
    pixelHeight: previewable ? 20 : null,
    createdAt: '2026-09-01T00:00:00Z',
    current: true,
  };
  return {
    itemId: ITEM,
    workspaceId: 'a3333333-3333-4333-8333-333333333333',
    current,
    versions: [current],
  };
}

function fakeClient(previewable: boolean): NixClient {
  return {
    query: vi.fn((endpoint: { operation: string }) => {
      if (endpoint.operation === 'files.get') return Promise.resolve(record(previewable));
      if (endpoint.operation === 'files.download') {
        return Promise.resolve({
          url: 'http://localhost:9447/preview',
          expiresAt: '2026-09-01T00:10:00Z',
          fileName: 'diagram.png',
          mediaType: 'image/png',
          byteLength: 7,
          sha256: '1'.repeat(64),
          inline: true,
          unscanned: true,
          noSniff: true,
        });
      }
      return Promise.reject(new Error(`Unexpected query ${endpoint.operation}`));
    }),
  } as unknown as NixClient;
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:nix-preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

describe('the file item viewer', () => {
  it('labels opaque files as unscanned and download-only without fetching their bytes', async () => {
    client = fakeClient(false);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByText(/unscanned attachment/i)).toBeVisible();
    expect(screen.getByText('diagram.png')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a loading state until the authorized image bytes become available', async () => {
    client = fakeClient(true);
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByRole('status')).toHaveTextContent(/loading the authorized image/i);
    release?.(new Response('payload', { status: 200, headers: { 'content-type': 'image/png' } }));
    expect(await screen.findByRole('img', { name: 'diagram.png' })).toHaveAttribute(
      'src',
      'blob:nix-preview',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps download available when an authorized preview is refused', async () => {
    client = fakeClient(true);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))));

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/preview is unavailable/i);
    expect(screen.getAllByRole('button', { name: 'Download' })[0]).toBeEnabled();
  });
});
