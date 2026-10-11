import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { NoteImageView } from '../../editor/note-image-view';
import * as offlineAssets from '../../offline/offline-assets';

const apiClient = vi.hoisted(() => ({}));
vi.mock('../../api/api-client-provider', () => ({ useApiClient: () => apiClient }));
vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
}));

function props(width: unknown, editable = true, fileItemId?: string) {
  return {
    node: { attrs: { src: 'https://example.test/image.png', alt: 'Diagram', width, fileItemId } },
    editor: { isEditable: editable },
    selected: true,
    updateAttributes: vi.fn(),
  } as unknown as Parameters<typeof NoteImageView>[0];
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('note image sizing', () => {
  it('renders the saved width and saves proportional sizing and reset', () => {
    const viewProps = props(240);
    render(<NoteImageView {...viewProps} />);
    expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('width', '240');
    fireEvent.change(screen.getByRole('slider', { name: 'Image width' }), {
      target: { value: '320' },
    });
    expect(viewProps.updateAttributes).toHaveBeenCalledWith({ width: 320, height: null });
    fireEvent.click(screen.getByRole('button', { name: 'Reset size' }));
    expect(viewProps.updateAttributes).toHaveBeenCalledWith({ width: null, height: null });
  });

  it('preserves sizing in read-only notes without offering editing controls', () => {
    render(<NoteImageView {...props(240, false)} />);
    expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('width', '240');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('ignores malformed dimensions', () => {
    render(<NoteImageView {...props(-20)} />);
    expect(screen.getByRole('img', { name: 'Diagram' })).not.toHaveAttribute('width');
  });
});

describe('offline note images', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('renders a scoped downloaded file image without contacting Core', async () => {
    const read = vi
      .spyOn(offlineAssets, 'readOfflineNoteAsset')
      .mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    URL.createObjectURL = vi.fn(() => 'blob:offline-image');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const viewProps = props(240, true, 'file-id');
    const view = render(
      <offlineAssets.OfflineNoteAssetsProvider scope="note-scope" offline>
        <NoteImageView {...viewProps} />
      </offlineAssets.OfflineNoteAssetsProvider>,
    );
    expect(await screen.findByRole('img', { name: 'Diagram' })).toHaveAttribute(
      'src',
      'blob:offline-image',
    );
    expect(read).toHaveBeenCalledWith('note-scope', 'file-id');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:offline-image');
  });
  it('explains that an external image is unavailable while offline', () => {
    render(
      <offlineAssets.OfflineNoteAssetsProvider offline>
        <NoteImageView {...props(240)} />
      </offlineAssets.OfflineNoteAssetsProvider>,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'This external image is unavailable offline.',
    );
  });
  it('revokes a mounted image when another tab refuses its file', async () => {
    localStorage.setItem('nix.offline-note-assets.subject', 'reader');
    vi.spyOn(offlineAssets, 'readOfflineNoteAsset')
      .mockResolvedValueOnce(new Blob(['image'], { type: 'image/png' }))
      .mockResolvedValue(null);
    URL.createObjectURL = vi.fn(() => 'blob:other-tab-image');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    render(
      <offlineAssets.OfflineNoteAssetsProvider scope="note-scope" offline>
        <NoteImageView {...props(240, true, 'file-id')} />
      </offlineAssets.OfflineNoteAssetsProvider>,
    );
    expect(await screen.findByRole('img', { name: 'Diagram' })).toHaveAttribute(
      'src',
      'blob:other-tab-image',
    );

    fireEvent(
      window,
      new StorageEvent('storage', {
        key: `nix.offline-note-assets.refused:${JSON.stringify(['reader', 'file-id'])}`,
        newValue: 'refused',
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(revoke).toHaveBeenCalledWith('blob:other-tab-image');
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This image has not been downloaded for offline use.',
    );
  });
  it('ignores a delayed sign-out message from a previous login of the same account', async () => {
    localStorage.setItem('nix.offline-note-assets.subject', 'reader');
    localStorage.setItem(`nix.body-cache.epoch.${JSON.stringify('reader')}`, 'current-login');
    let receive: ((event: MessageEvent<unknown>) => void) | undefined;
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void): void {
          receive = listener;
        }
        postMessage = vi.fn();
        close = vi.fn();
      },
    );
    const read = vi
      .spyOn(offlineAssets, 'readOfflineNoteAsset')
      .mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    URL.createObjectURL = vi.fn(() => 'blob:current-login-image');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    render(
      <offlineAssets.OfflineNoteAssetsProvider scope="note-scope" offline>
        <NoteImageView {...props(240, true, 'file-id')} />
      </offlineAssets.OfflineNoteAssetsProvider>,
    );
    expect(await screen.findByRole('img', { name: 'Diagram' })).toHaveAttribute(
      'src',
      'blob:current-login-image',
    );
    if (receive === undefined) throw new Error('The image cache did not subscribe to other tabs.');
    const onMessage = receive;
    act(() => {
      onMessage(
        new MessageEvent('message', {
          data: {
            kind: 'closed',
            expectedSubject: 'reader',
            epoch: 'previous-login',
          },
        }),
      );
    });
    expect(read).toHaveBeenCalledOnce();
    expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute(
      'src',
      'blob:current-login-image',
    );
    expect(revoke).not.toHaveBeenCalled();
  });
});
