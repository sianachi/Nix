import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { OfflineNote, OfflineSnapshot } from '../../offline/offline-store';
import type { NoteEditorProps } from '../../editor/note-editor';
import { AuthProvider } from '../../auth/auth-provider';
import * as bodies from '../../editor/body-cache';
import * as collaboration from '../../editor/collab-sync';
import * as drafts from '../../editor/draft-journal';
import { useSessionStore } from '../../auth/session-store';
import { OfflineNotesPage } from '../../offline/offline-notes-page';
import { OfflineStatus } from '../../offline/offline-status';
import { RequireSession } from '../../shell/require-session';
import { renderAt } from '../render-with-router';
import { Route, Routes } from 'react-router';

const state = vi.hoisted(
  (): {
    snapshot: OfflineSnapshot | undefined;
    listeners: Set<() => void>;
    create: Mock<
      (workspaceId: string, parentId: string | null, title: string) => Promise<OfflineNote>
    >;
    rename: Mock<(id: string, title: string) => Promise<void>>;
    flush: Mock<() => Promise<void>>;
    providerStarts: number;
  } => ({
    snapshot: undefined,
    listeners: new Set<() => void>(),
    create: vi.fn(),
    rename: vi.fn(),
    flush: vi.fn(),
    providerStarts: 0,
  }),
);

vi.mock('../../offline/offline-store', () => ({
  getOfflineSnapshot: () => state.snapshot,
  subscribeOfflineNotes: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
  loadOfflineNotes: () => Promise.resolve(),
  createOfflineNote: state.create,
  renameOfflineNote: state.rename,
  readOfflineAccount: () => state.snapshot?.account ?? null,
}));

vi.mock('../../offline/offline-runtime', () => ({ requestOfflineSync: vi.fn() }));

vi.mock('../../editor/note-editor', () => ({
  NoteEditor: (props: NoteEditorProps) => {
    const { onSync } = props;
    useEffect(() => {
      state.providerStarts += 1;
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      onSync?.({
        awareness,
        flushLocal: state.flush,
        flushAndWait: () => Promise.resolve(),
        syncAndCache: () => Promise.resolve(),
        destroy: () => undefined,
      });
      return () => {
        onSync?.(null);
        awareness.destroy();
        doc.destroy();
      };
    }, [onSync]);
    return (
      <div
        role="textbox"
        aria-label="Note contents"
        aria-readonly={!props.localCanWrite}
        data-offline={String(props.offline)}
        data-item-id={props.itemId}
      />
    );
  },
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const noteId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const profile = { subject: 'offline-person', name: 'Offline Person', email: null };
const note = {
  id: noteId,
  workspaceId,
  parentId: null,
  title: 'Weekly writing',
  canWrite: true,
  bodyAvailable: true,
  publication: { kind: 'published' as const, serverId: noteId, docId: 'doc-1' },
  pendingTitle: null,
  blockedReason: null,
};

beforeEach(() => {
  state.create.mockReset();
  state.rename.mockReset();
  state.flush.mockReset().mockResolvedValue(undefined);
  vi.spyOn(drafts, 'listDraftScopes').mockResolvedValue([]);
  vi.spyOn(collaboration, 'flushLocalDraftsForAccount').mockResolvedValue(undefined);
  state.rename.mockResolvedValue(undefined);
  state.providerStarts = 0;
  state.listeners.clear();
  state.snapshot = {
    account: profile,
    workspaces: [
      {
        id: workspaceId,
        name: 'Personal notes',
        kind: 'personal',
        lifecycleState: 'active',
        archivedAt: null,
        createdAt: '2026-10-11T00:00:00Z',
        versionRetentionDays: 30,
        storageQuotaBytes: 0,
        canRename: true,
        canManageMembers: false,
        canLeave: false,
        canUseDailyNotes: true,
        pendingInvitationId: null,
      },
    ],
    notes: [note, { ...note, id: otherId, title: 'Trip journal', parentId: noteId }],
    status: 'offline',
    completed: 2,
    total: 2,
    pending: 0,
    error: null,
    lastSyncedAt: null,
  };
  useSessionStore.setState({
    status: 'unreachable',
    profile,
    error: null,
    unreachable: { cause: 'offline', lastTriedAt: Date.now() },
  });
});

function renderPage(url = '/offline') {
  return renderAt(
    <AuthProvider>
      <OfflineNotesPage />
    </AuthProvider>,
    url,
  );
}

it('shows offline storage failure even when its account marker could not be saved', () => {
  useSessionStore.setState({ status: 'authenticated', profile });
  if (state.snapshot === undefined) throw new Error('Offline fixture missing.');
  state.snapshot = {
    ...state.snapshot,
    account: null,
    status: 'error',
    error: 'Storage quota exceeded.',
  };
  renderAt(<OfflineStatus />, '/');
  expect(screen.getByRole('status')).toHaveTextContent(
    'Offline notes are unavailable on this device.',
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Storage quota exceeded.');
  expect(screen.queryByRole('link', { name: 'Notes on this device' })).not.toBeInTheDocument();
});

it('does not show another account’s offline error status', () => {
  useSessionStore.setState({ status: 'authenticated', profile });
  if (state.snapshot === undefined) throw new Error('Offline fixture missing.');
  state.snapshot = {
    ...state.snapshot,
    account: { subject: 'another-person', name: 'Another Person', email: null },
    status: 'error',
    error: 'Private note download failed.',
  };
  renderAt(<OfflineStatus />, '/');
  expect(screen.queryByLabelText('Offline notes status')).not.toBeInTheDocument();
  expect(screen.queryByText('Private note download failed.')).not.toBeInTheDocument();
});

describe('notes saved on this device', () => {
  it('finds an unopened nested note by title without querying Core', async () => {
    renderPage();
    await userEvent
      .setup()
      .type(screen.getByRole('searchbox', { name: 'Search saved notes' }), 'Trip');
    const navigation = screen.getByRole('navigation', { name: 'Saved notes' });
    expect(
      within(navigation).queryByRole('button', { name: /^Weekly writing/ }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(navigation).getByRole('button', { name: /^Trip journal/ }));
    expect(await screen.findByRole('textbox', { name: 'Note contents' })).toHaveAttribute(
      'data-offline',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Trip journal');
  });

  it('opens the note selected by a stable offline deep link', () => {
    renderPage(`/offline?workspace=${workspaceId}&item=${otherId}`);
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Trip journal');
  });

  it('creates a local note in the chosen parent and opens it', async () => {
    state.create.mockImplementation((workspace: string, parent: string | null, title: string) => {
      const created: OfflineNote = {
        ...note,
        id: 'new-local-id',
        workspaceId: workspace,
        parentId: parent,
        title,
        publication: {
          kind: 'pending',
          key: 'key',
          originalTitle: title,
          originalParentId: parent,
        },
      };
      if (state.snapshot)
        state.snapshot = {
          ...state.snapshot,
          notes: [...state.snapshot.notes, created],
          pending: 1,
        };
      for (const listener of state.listeners) listener();
      return Promise.resolve(created);
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New note' }));
    const dialog = screen.getByRole('dialog', { name: 'New note' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Note title' }), 'Offline ideas');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Create in' }), noteId);
    await user.click(within(dialog).getByRole('button', { name: 'Create note' }));
    expect(state.create).toHaveBeenCalledWith(
      workspaceId,
      noteId,
      'Offline ideas',
      profile.subject,
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New note' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Offline ideas');
    expect(screen.getByRole('textbox', { name: 'Note contents' })).toHaveAttribute(
      'data-item-id',
      'new-local-id',
    );
  });

  it('keeps the current note open when its local edits cannot flush', async () => {
    state.flush.mockRejectedValue(new Error('Storage full'));
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Trip journal/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep this note open');
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Weekly writing');
  });

  it('waits for a title save and keeps the note open if it fails', async () => {
    let refuse: ((error: Error) => void) | undefined;
    state.rename.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
    );
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    const user = userEvent.setup();
    const title = screen.getByRole('textbox', { name: 'Note title' });
    await user.clear(title);
    await user.type(title, 'Unsynced title');
    await user.click(screen.getByRole('button', { name: /^Trip journal/ }));
    expect(state.rename).toHaveBeenCalledWith(noteId, 'Unsynced title', profile.subject);
    expect(title).toHaveValue('Unsynced title');
    await act(async () => {
      refuse?.(new Error('Storage full'));
      await Promise.resolve();
    });
    expect(screen.getByRole('textbox', { name: 'Note title' })).toBe(title);
    expect(screen.getByText(/Keep this note open/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Note contents' })).toHaveAttribute(
      'data-item-id',
      noteId,
    );
  });

  it('makes cached read-only notes uneditable', () => {
    if (state.snapshot)
      state.snapshot = { ...state.snapshot, notes: [{ ...note, canWrite: false }] };
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'Note contents' })).toHaveAttribute(
      'aria-readonly',
      'true',
    );
  });

  it('allows leaving after a failed title is reverted to its stored value', async () => {
    state.rename.mockRejectedValue(new Error('Use a note title between 1 and 255 characters.'));
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    const user = userEvent.setup();
    const title = screen.getByRole('textbox', { name: 'Note title' });
    await user.clear(title);
    await user.click(screen.getByRole('button', { name: /^Trip journal/ }));
    expect(screen.getByRole('textbox', { name: 'Note title' })).toBe(title);
    await user.type(title, note.title);
    await user.click(screen.getByRole('button', { name: /^Trip journal/ }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Trip journal');
    });
    expect(state.rename).toHaveBeenCalledTimes(1);
  });

  it('immediately removes an open note body when its copy is marked unavailable', () => {
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    expect(screen.getByRole('textbox', { name: 'Note contents' })).toBeVisible();
    act(() => {
      if (state.snapshot)
        state.snapshot = {
          ...state.snapshot,
          notes: state.snapshot.notes.map((entry) =>
            entry.id === noteId
              ? {
                  ...entry,
                  bodyAvailable: false,
                  canWrite: false,
                  blockedReason: 'Access is unavailable.',
                }
              : entry,
          ),
        };
      for (const listener of state.listeners) listener();
    });
    expect(screen.queryByRole('textbox', { name: 'Note contents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Note title' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export local edits' })).toBeVisible();
  });

  it('adopts refreshed titles without writing an unintended rename', async () => {
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    act(() => {
      if (state.snapshot)
        state.snapshot = {
          ...state.snapshot,
          notes: state.snapshot.notes.map((entry) =>
            entry.id === noteId ? { ...entry, title: 'Title from another device' } : entry,
          ),
        };
      for (const listener of state.listeners) listener();
    });
    const title = screen.getByRole('textbox', { name: 'Note title' });
    expect(title).toHaveValue('Title from another device');
    await userEvent.setup().click(title);
    await userEvent.setup().tab();
    expect(state.rename).not.toHaveBeenCalled();
  });

  it('keeps the collaboration provider when download progress changes', () => {
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    const initialStarts = state.providerStarts;
    act(() => {
      if (state.snapshot)
        state.snapshot = { ...state.snapshot, status: 'downloading', completed: 1 };
      for (const listener of state.listeners) listener();
    });
    expect(state.providerStarts).toBe(initialStarts);
  });

  it('closes the editor when another tab clears cached account access', () => {
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    act(() => {
      if (state.snapshot) state.snapshot = { ...state.snapshot, account: null };
      for (const listener of state.listeners) listener();
    });
    expect(screen.queryByRole('textbox', { name: 'Note contents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Weekly writing/ })).not.toBeInTheDocument();
  });

  it('offers pending edit recovery after the workspace is no longer accessible', () => {
    if (state.snapshot)
      state.snapshot = {
        ...state.snapshot,
        workspaces: [],
        notes: [
          {
            ...note,
            bodyAvailable: false,
            canWrite: false,
            pendingTitle: 'My unsynced title',
            blockedReason: 'Access is no longer available.',
          },
        ],
        pending: 1,
      };
    renderPage();
    const recovery = screen.getByRole('region', { name: 'Pending edits to recover' });
    expect(within(recovery).getByText('My unsynced title')).toBeVisible();
    expect(within(recovery).getByRole('button', { name: 'Export local edits' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Note contents' })).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly writing')).not.toBeInTheDocument();
  });

  it('keeps the current note open when opening the online workspace cannot flush', async () => {
    useSessionStore.setState({ status: 'authenticated' });
    state.flush.mockRejectedValue(new Error('Storage full'));
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep this note open');
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Weekly writing');
  });

  it('keeps its editor mounted during a cached-account session retry', () => {
    renderAt(
      <AuthProvider>
        <Routes>
          <Route element={<RequireSession />}>
            <Route path="*" element={<div>Online workspace</div>} />
          </Route>
        </Routes>
      </AuthProvider>,
      `/offline?workspace=${workspaceId}&item=${noteId}`,
    );
    const editor = screen.getByRole('textbox', { name: 'Note contents' });
    useSessionStore.setState({ status: 'authenticating' });
    expect(screen.getByRole('textbox', { name: 'Note contents' })).toBe(editor);
    expect(screen.queryByText('Online workspace')).not.toBeInTheDocument();
  });

  it('flushes an immediate edit and confirms pending work before its counter updates', async () => {
    vi.spyOn(drafts, 'listDraftScopes').mockResolvedValue(['pending-existing-note']);
    renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(state.flush).toHaveBeenCalled();
    expect(drafts.listDraftScopes).toHaveBeenCalledWith(profile.subject);
    expect(screen.getByRole('dialog', { name: 'Sign out with pending changes?' })).toBeVisible();
    expect(useSessionStore.getState().status).toBe('unreachable');
    expect(state.snapshot?.pending).toBe(0);
  });

  it.each(['local save', 'pending inventory'])(
    'keeps the editor open when sign-out cannot verify %s',
    async (failure) => {
      if (failure === 'local save') state.flush.mockRejectedValue(new Error('Local save failed.'));
      else
        vi.spyOn(drafts, 'listDraftScopes').mockRejectedValue(
          new Error('Pending inventory failed.'),
        );
      renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('failed.');
      expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Weekly writing');
      expect(screen.getByRole('textbox', { name: 'Note contents' })).toBeInTheDocument();
      expect(useSessionStore.getState().status).toBe('unreachable');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it.each(['another account', 'a fresh session for the same account'])(
    'does not confirm an old sign-out request after %s is admitted',
    async (changed) => {
      if (state.snapshot) state.snapshot = { ...state.snapshot, pending: 1 };
      const epoch = vi.spyOn(bodies, 'bodyCacheAccountEpoch').mockReturnValue('original');
      renderPage(`/offline?workspace=${workspaceId}&item=${noteId}`);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
      expect(screen.getByRole('dialog', { name: 'Sign out with pending changes?' })).toBeVisible();
      epoch.mockReturnValue('replacement');
      if (changed === 'another account')
        useSessionStore.setState({
          profile: { subject: 'another-person', name: 'Another Person', email: null },
        });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Sign out and remove local notes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('account changed');
      expect(useSessionStore.getState().status).toBe('unreachable');
      expect(useSessionStore.getState().profile?.subject).toBe(
        changed === 'another account' ? 'another-person' : profile.subject,
      );
    },
  );

  it('requires a deliberate choice before clearing unsynced notes on sign-out', async () => {
    if (state.snapshot) state.snapshot = { ...state.snapshot, pending: 1 };
    renderPage();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('dialog', { name: 'Sign out with pending changes?' })).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(
      screen.queryByRole('dialog', { name: 'Sign out with pending changes?' }),
    ).not.toBeInTheDocument();
  });
});
