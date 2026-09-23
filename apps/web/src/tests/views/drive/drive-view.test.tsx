import { fireEvent, render, screen, within } from '@testing-library/react';
import type * as apiClient from '@nix/api-client';
import type { NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';
import type { Item } from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import { DriveView } from '../../../views/drive/drive-view';

/**
 * The drive view: a container's children as a file manager.
 *
 * Every test builds its own fake `NixClient` and its own fake `WorkspaceTree` rather than reaching
 * the real hooks - the drive fetches file facts lazily through the client (`fileByItem`) and moves
 * items through the tree (`move`), and a test about either wants to see exactly what was asked for
 * without a real network or a real workspace behind it.
 */

const WORKSPACE = 'a1000000-0000-4000-8000-000000000001';
const CONTAINER = 'c1000000-0000-4000-8000-000000000001';

function itemOf(overrides: Partial<Item> & { id: string; title: string }): Item {
  return {
    workspaceId: WORKSPACE,
    parentId: CONTAINER,
    type: 'note',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const NOTE = itemOf({ id: 'i-note', title: 'Bravo note', type: 'note', seq: 1000 });
const FOLDER = itemOf({
  id: 'i-folder',
  title: 'Alpha folder',
  type: 'note',
  hasChildren: true,
  seq: 1500,
});
const FILE_A = itemOf({
  id: 'i-file-a',
  title: 'Charlie file',
  type: 'file',
  seq: 2000,
  updatedAt: '2026-02-01T00:00:00Z',
});
const FILE_B = itemOf({
  id: 'i-file-b',
  title: 'Delta file',
  type: 'file',
  seq: 2500,
  updatedAt: '2026-03-01T00:00:00Z',
});

function fileVersion(id: string, fileName: string, byteLength: number) {
  return {
    id,
    version: 1,
    fileName,
    mediaType: 'text/plain',
    byteLength,
    sha256: '1'.repeat(64),
    previewable: false,
    pixelWidth: null,
    pixelHeight: null,
    createdAt: '2026-02-01T00:00:00Z',
    current: true,
  };
}

function fileRecordFor(itemId: string, fileName: string, byteLength: number) {
  const version = fileVersion(`${itemId}-v1`, fileName, byteLength);
  return { itemId, workspaceId: WORKSPACE, current: version, versions: [version] };
}

const { moveMock, reloadMock, fetchFileContentMock, beginUploadMock, uploadAndCompleteFileMock } =
  vi.hoisted(() => ({
    moveMock: vi.fn(() => Promise.resolve({ refusal: null })),
    reloadMock: vi.fn(() => Promise.resolve()),
    fetchFileContentMock: vi.fn(() => Promise.resolve({ blob: new Blob(['x']) })),
    beginUploadMock: vi.fn((input: unknown) => ({ operation: 'files.upload.begin', body: input })),
    uploadAndCompleteFileMock: vi.fn(() =>
      Promise.resolve({
        itemId: 'new',
        workspaceId: 'a1000000-0000-4000-8000-000000000001',
        current: {
          id: 'new-v1',
          version: 1,
          fileName: 'new.txt',
          mediaType: 'text/plain',
          byteLength: 3,
          sha256: '1'.repeat(64),
          previewable: false,
          pixelWidth: null,
          pixelHeight: null,
          createdAt: '2026-02-01T00:00:00Z',
          current: true,
        },
        versions: [],
      }),
    ),
  }));

vi.mock('../../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

vi.mock('../../../items/use-workspace-tree', () => ({
  useWorkspaceTree: () => ({
    status: 'ready',
    error: null,
    items: [],
    childrenOf: () => [],
    isExpanded: () => false,
    isLoadingChildren: () => false,
    isLocked: () => false,
    breadcrumbs: () => [],
    find: () => null,
    reveal: () => Promise.resolve(),
    revealOf: () => null,
    retryReveal: () => Promise.resolve(),
    isCreating: false,
    isSaving: false,
    toggle: () => Promise.resolve(),
    expand: () => Promise.resolve(),
    create: () => Promise.resolve({ id: null, refusal: null }),
    createStructured: () => Promise.resolve({ id: null, refusal: null }),
    rename: () => Promise.resolve(),
    move: moveMock,
    remove: () => Promise.resolve({ refusal: null }),
    restore: () => Promise.resolve({ refusal: null }),
    reload: () => Promise.resolve(),
  }),
}));

let client: NixClient;

vi.mock('../../../api/api-client-provider', () => ({
  useApiClient: () => client,
}));

vi.mock('@nix/api-client', async () => {
  const actual = await vi.importActual<typeof apiClient>('@nix/api-client');
  return {
    ...actual,
    files: {
      ...actual.files,
      beginUpload: beginUploadMock,
      uploadAndCompleteFile: uploadAndCompleteFileMock,
      fetchFileContent: fetchFileContentMock,
    },
  };
});

function fakeClient(): NixClient {
  return {
    query: vi.fn((endpoint: { operation: string; path: string }) => {
      if (endpoint.operation === 'files.get') {
        if (endpoint.path.includes(FILE_A.id))
          return Promise.resolve(fileRecordFor(FILE_A.id, 'notes.txt', 128));
        if (endpoint.path.includes(FILE_B.id))
          return Promise.resolve(fileRecordFor(FILE_B.id, 'report.csv', 4096));
        return Promise.reject(new Error(`Unexpected file id in ${endpoint.path}`));
      }
      return Promise.reject(new Error(`Unexpected query ${endpoint.operation}`));
    }),
    execute: vi.fn(() => Promise.resolve({ id: 'upload-id' })),
  } as unknown as NixClient;
}

function driveOf(options: {
  readonly items: readonly Item[];
  readonly onOpen?: (id: string) => void;
}) {
  const container: ContainerData = aContainer({
    itemId: null, // a workspace root: no "Parent" destination to resolve
    children: [...options.items],
    reload: reloadMock,
  });

  return (
    <DriveView
      container={container}
      view={aView({ kind: 'drive' })}
      onOpen={options.onOpen ?? (() => undefined)}
    />
  );
}

beforeEach(() => {
  client = fakeClient();
  moveMock.mockClear();
  reloadMock.mockClear();
  fetchFileContentMock.mockClear();
  beginUploadMock.mockClear();
  uploadAndCompleteFileMock.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:nix-drive'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the drive view', () => {
  it('draws a row for every child, naming its kind and icon by its body kind', async () => {
    render(driveOf({ items: [NOTE, FOLDER, FILE_A] }));

    expect(await screen.findByRole('button', { name: 'Bravo note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charlie file' })).toBeInTheDocument();

    // The row's own <tr> carries the kind and size cells; find it from the name button.
    const row = screen.getByRole('button', { name: 'Alpha folder' }).closest('tr');
    if (row === null) throw new Error('The row did not render inside a <tr>.');
    expect(within(row).getByText('Note')).toBeInTheDocument();
  });

  it('fetches file facts lazily and shows the size once it resolves', async () => {
    render(driveOf({ items: [FILE_A] }));

    const row = screen.getByRole('button', { name: 'Charlie file' }).closest('tr');
    if (row === null) throw new Error('The row did not render inside a <tr>.');
    expect(within(row).getByText('—')).toBeInTheDocument();

    expect(await within(row).findByText('128 B')).toBeInTheDocument();
    expect(within(row).getByText('TXT')).toBeInTheDocument();
  });

  it('sorts by name ascending by default and reverses on a second click', () => {
    render(driveOf({ items: [FILE_B, NOTE, FOLDER] }));

    const names = () =>
      screen.getAllByRole('button', { name: /note|folder|file/i }).map((b) => b.textContent);
    expect(names()).toEqual(['Alpha folder', 'Bravo note', 'Delta file']);

    fireEvent.click(screen.getByRole('button', { name: /^Name/ }));
    expect(names()).toEqual(['Delta file', 'Bravo note', 'Alpha folder']);
  });

  it('selects a range with shift-click and everything with select-all', () => {
    render(driveOf({ items: [FOLDER, NOTE, FILE_A] }));

    const checkboxFor = (title: string) =>
      screen.getByRole('checkbox', { name: `Select ${title}` });

    fireEvent.click(checkboxFor('Alpha folder'));
    fireEvent.click(checkboxFor('Charlie file'), { shiftKey: true });

    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toHaveTextContent('3 selected');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toHaveTextContent('3 selected');
  });

  it('downloads only the selected files, skipping the rest of the selection', async () => {
    render(driveOf({ items: [NOTE, FILE_A, FILE_B] }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));

    await vi.waitFor(() => {
      expect(fetchFileContentMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchFileContentMock).toHaveBeenCalledWith(client, FILE_A.id);
    expect(fetchFileContentMock).toHaveBeenCalledWith(client, FILE_B.id);
  });

  it('moves every selected item through the Move dialog', async () => {
    render(driveOf({ items: [NOTE, FOLDER, FILE_A] }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bravo note' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Charlie file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));

    const dialog = screen.getByRole('dialog', { name: 'Move to…' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Alpha folder' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Move 2 items/ }));

    await vi.waitFor(() => {
      expect(moveMock).toHaveBeenCalledTimes(2);
    });
    expect(moveMock).toHaveBeenCalledWith(NOTE.id, FOLDER.id, null);
    expect(moveMock).toHaveBeenCalledWith(FILE_A.id, FOLDER.id, null);
    expect(reloadMock).toHaveBeenCalled();
  });

  it('uploads OS files dropped onto the view into this container', async () => {
    const { container: root } = render(driveOf({ items: [NOTE] }));

    const region = root.firstElementChild;
    if (region === null) throw new Error('The drive rendered nothing to drop onto.');
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const dataTransfer = {
      files: [file],
      types: ['Files'],
      items: [{ kind: 'file' }],
    };

    fireEvent.drop(region, { dataTransfer });

    await vi.waitFor(() => {
      expect(beginUploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE, parentId: null, fileName: 'hello.txt' }),
      );
    });
    expect(uploadAndCompleteFileMock).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });
  });
});
