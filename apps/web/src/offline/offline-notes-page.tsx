import { Button, Dialog, Field, Input, Select, Text, focusRing } from '@nix/ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useSessionStore } from '../auth/session-store';
import { NoteEditor } from '../editor/note-editor';
import type { CollabSync } from '../editor/collab-sync';
import {
  createOfflineNote,
  getOfflineSnapshot,
  loadOfflineNotes,
  renameOfflineNote,
  subscribeOfflineNotes,
  type OfflineNote,
} from './offline-store';
import { useOfflinePreference } from './offline-preference';
import { OfflineStatus } from './offline-status';
import { requestOfflineSync } from './offline-runtime';
import { offlineRecoveryFile } from './offline-recovery';
import { useNetworkOnline } from './use-network-online';
import { usePendingSignOut } from './use-pending-sign-out';

export function OfflineNotesPage(): ReactNode {
  const snapshot = useSyncExternalStore(subscribeOfflineNotes, getOfflineSnapshot);
  const offlineOn = useOfflinePreference((state) => state.enabled);
  const profile = useSessionStore((state) => state.profile);
  const status = useSessionStore((state) => state.status);
  const online = useNetworkOnline();
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const workspaceChoice =
    query.get('workspace') ?? /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? '';
  const selectedId = query.get('item');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncRef = useRef<CollabSync | null>(null);
  const titleSaveRef = useRef<Promise<void> | null>(null);
  const rememberTitleSave = useCallback((saving: Promise<void> | null): void => {
    titleSaveRef.current = saving;
  }, []);
  // NoteEditor uses this callback as a provider lifecycle dependency.
  const rememberSync = useCallback((sync: CollabSync | null): void => {
    syncRef.current = sync;
  }, []);
  const pendingSignOut = usePendingSignOut(async () => {
    await titleSaveRef.current;
    await syncRef.current?.flushLocal();
  });
  const ownsSnapshot = profile !== null && snapshot.account?.subject === profile.subject;
  const workspaces = (ownsSnapshot ? snapshot.workspaces : []).filter(
    (workspace) => workspace.lifecycleState === 'active',
  );
  const workspaceId = workspaces.some((workspace) => workspace.id === workspaceChoice)
    ? workspaceChoice
    : (workspaces[0]?.id ?? '');
  const workspaceNotes = ownsSnapshot
    ? snapshot.notes.filter((note) => note.workspaceId === workspaceId)
    : [];
  const filtered = workspaceNotes.filter((note) =>
    note.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const notesById = new Map(snapshot.notes.map((note) => [note.id, note]));
  const recoveryNotes = ownsSnapshot
    ? snapshot.notes.filter(
        (note) =>
          note.blockedReason !== null &&
          !workspaces.some((workspace) => workspace.id === note.workspaceId),
      )
    : [];
  const selected = workspaceNotes.find((note) => note.id === selectedId && note.bodyAvailable);
  const offline = !online || status !== 'authenticated';

  useEffect(() => {
    void loadOfflineNotes().catch(() => {
      setError(
        'Notes saved on this device could not be opened. Keep this site’s storage and try again.',
      );
    });
  }, []);
  useEffect(() => {
    if (selected === undefined) titleSaveRef.current = null;
  }, [selected]);

  async function selectNote(id: string | null, destinationWorkspace = workspaceId): Promise<void> {
    const query = new URLSearchParams({ workspace: destinationWorkspace });
    if (id !== null) query.set('item', id);
    await navigateAfterSaving(`/offline?${query.toString()}`);
  }

  async function navigateAfterSaving(destination: string): Promise<void> {
    try {
      await titleSaveRef.current;
      await syncRef.current?.flushLocal();
      await navigate(destination);
    } catch {
      setError(
        'Your latest edits could not be saved on this device. Keep this note open until they are safe.',
      );
    }
  }

  async function create(): Promise<void> {
    if (saving || workspaceId === '' || profile === null) return;
    setSaving(true);
    setError(null);
    try {
      const note = await createOfflineNote(
        workspaceId,
        parentId || null,
        title.trim() || 'Untitled note',
        profile.subject,
      );
      await selectNote(note.id);
      setCreating(false);
      setTitle('');
      requestOfflineSync();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The note could not be saved on this device.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function exportRecovery(note: OfflineNote): Promise<void> {
    try {
      if (profile === null) throw new Error('Sign in to recover your pending edits.');
      const blob = await offlineRecoveryFile(note, profile.subject);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `nix-pending-edits-${note.id}.json`;
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The saved edits could not be exported.');
    }
  }

  return (
    // design-token-exempt: device safe-area insets protect content in the installed app.
    <div className="flex h-dvh flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]">
      <a
        href={selected ? '#offline-note' : '#offline-notes'}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:text-foreground"
      >
        Skip to {selected ? 'note' : 'saved notes'}
      </a>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-divider px-4 py-3">
        <div>
          <Text as="h1" variant="h2">
            Notes on this device
          </Text>
          {offlineOn ? null : (
            <Text as="p" variant="note" role="status">
              Keeping notes on this device is turned off in Settings, under Editor. What is listed
              here stays until you clear it; nothing new is saved or synced.
            </Text>
          )}
          <Text as="p" variant="caption" tone="muted">
            {offline
              ? 'Working offline. Changes sync when Nix reconnects.'
              : 'Your notes are saved here for offline use.'}
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {!offline && workspaceId !== '' ? (
            <button
              type="button"
              onClick={() =>
                void navigateAfterSaving(
                  `/w/${workspaceId}${selected?.publication.kind === 'published' ? `?item=${selected.publication.serverId}` : ''}`,
                )
              }
              className={`text-sm underline underline-offset-2 ${focusRing}`}
            >
              Open workspace
            </button>
          ) : null}
          <Button
            variant="ghost"
            disabled={pendingSignOut.phase !== 'idle'}
            onClick={() => {
              setError(null);
              void pendingSignOut.requestSignOut();
            }}
          >
            {pendingSignOut.phase === 'checking'
              ? 'Checking saved edits…'
              : pendingSignOut.phase === 'signing-out'
                ? 'Signing out…'
                : 'Sign out'}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          id="offline-notes"
          tabIndex={-1}
          aria-label="Saved notes"
          className={`${selected ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-divider md:w-80`}
        >
          <div className="flex flex-col gap-3 p-4">
            <Field label="Workspace">
              {(control) => (
                <Select
                  {...control}
                  value={workspaceId}
                  onChange={(event) => {
                    void selectNote(null, event.target.value);
                    setParentId('');
                    setVisibleCount(100);
                  }}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Search saved notes">
              {(control) => (
                <Input
                  {...control}
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setVisibleCount(100);
                  }}
                />
              )}
            </Field>
            <Button
              disabled={workspaceId === ''}
              onClick={() => {
                setCreating(true);
                setError(null);
              }}
            >
              New note
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {snapshot.status === 'loading' ? (
              <Text as="p" variant="note" tone="muted" className="px-2">
                Loading saved notes…
              </Text>
            ) : null}
            {filtered.length === 0 && snapshot.status !== 'loading' ? (
              <Text as="p" variant="note" tone="muted" className="px-2">
                {search
                  ? 'No saved notes match this title.'
                  : 'No notes are saved in this workspace yet. Reconnect to download them, or create a new note.'}
              </Text>
            ) : null}
            <ul className="flex flex-col gap-1">
              {filtered.slice(0, visibleCount).map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    disabled={!note.bodyAvailable}
                    aria-current={note.id === selectedId ? 'page' : undefined}
                    className={`flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-accent/10 disabled:opacity-50 ${focusRing}`}
                    onClick={() => void selectNote(note.id)}
                  >
                    <Text as="span" variant="body" className="max-w-full truncate">
                      {note.title || 'Untitled note'}
                    </Text>
                    <Text as="span" variant="caption" tone="muted">
                      {note.blockedReason ??
                        (!note.bodyAvailable
                          ? 'Not downloaded yet'
                          : note.publication.kind === 'pending'
                            ? 'New note, saved on this device'
                            : note.pendingTitle !== null
                              ? 'Title saved on this device'
                              : (notesById.get(note.parentId ?? '')?.title ?? 'Workspace'))}
                    </Text>
                  </button>
                  {note.blockedReason !== null ? (
                    <Button variant="ghost" onClick={() => void exportRecovery(note)}>
                      Export local edits
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {filtered.length > visibleCount ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setVisibleCount((count) => count + 100);
                }}
              >
                Show more notes ({String(filtered.length - visibleCount)} remaining)
              </Button>
            ) : null}
            {recoveryNotes.length > 0 ? (
              <section
                aria-label="Pending edits to recover"
                className="flex flex-col gap-2 px-2 py-3"
              >
                <Text as="h2" variant="h3">
                  Pending edits to recover
                </Text>
                <Text as="p" variant="caption" tone="muted">
                  These workspaces are unavailable. Export your saved edits for recovery.
                </Text>
                {recoveryNotes.map((note) => (
                  <div key={note.id} className="flex flex-col gap-1">
                    <Text as="span" variant="body">
                      {note.pendingTitle ??
                        (note.publication.kind === 'pending' ? note.title : 'Saved note edits')}
                    </Text>
                    <Button variant="ghost" onClick={() => void exportRecovery(note)}>
                      Export local edits
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}
          </div>
        </nav>
        <main
          id="offline-note"
          tabIndex={-1}
          className={`${selected ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}
        >
          {selected && profile ? (
            <>
              <div className="flex items-center gap-3 border-b border-divider px-4 py-2">
                <Button variant="ghost" className="md:hidden" onClick={() => void selectNote(null)}>
                  All notes
                </Button>
                <OfflineTitle
                  key={selected.id}
                  note={selected}
                  subject={profile.subject}
                  onSave={rememberTitleSave}
                />
              </div>
              {selected.blockedReason ? (
                <Text variant="note" role="alert" className="px-4 py-2">
                  {selected.blockedReason}
                </Text>
              ) : null}
              <NoteEditor
                key={selected.id}
                itemId={
                  selected.publication.kind === 'published'
                    ? selected.publication.serverId
                    : selected.id
                }
                cacheBody
                offline={offline || selected.publication.kind !== 'published'}
                localScope={{ subject: profile.subject, workspaceId }}
                localCanWrite={selected.canWrite && selected.blockedReason === null}
                onSync={rememberSync}
                parentId={selected.parentId}
              />
            </>
          ) : (
            <Text as="p" variant="note" tone="muted" className="m-auto p-6">
              Choose a saved note to read or edit.
            </Text>
          )}
        </main>
      </div>
      {error || pendingSignOut.error ? (
        <Text variant="note" role="alert" className="px-4 py-2">
          {error ?? pendingSignOut.error}
        </Text>
      ) : null}
      <OfflineStatus detailed />
      <Dialog
        open={creating}
        title="New note"
        onClose={() => {
          if (!saving) setCreating(false);
        }}
        actions={
          <Button disabled={saving} onClick={() => void create()}>
            {saving ? 'Saving…' : 'Create note'}
          </Button>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field label="Note title">
            {(control) => (
              <Input
                {...control}
                value={title}
                disabled={saving}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Create in">
            {(control) => (
              <Select
                {...control}
                value={parentId}
                disabled={saving}
                onChange={(event) => {
                  setParentId(event.target.value);
                }}
              >
                <option value="">Workspace</option>
                {workspaceNotes
                  .filter((note) => note.canWrite && note.blockedReason === null)
                  .map((note) => (
                    <option key={note.id} value={note.id}>
                      {note.title || 'Untitled note'}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Text as="p" variant="caption" tone="muted">
            The note saves on this device first and publishes when Nix reconnects.
          </Text>
        </form>
      </Dialog>
      {pendingSignOut.dialog}
    </div>
  );
}

function OfflineTitle({
  note,
  subject,
  onSave,
}: {
  readonly note: OfflineNote;
  readonly subject: string;
  readonly onSave: (saving: Promise<void> | null) => void;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <div className="min-w-0 flex-1">
      <Input
        aria-label="Note title"
        value={draft ?? note.title}
        disabled={saving}
        readOnly={!note.canWrite || note.blockedReason !== null}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (draft === null) return;
          if (draft === note.title) {
            setDraft(null);
            setError(null);
            onSave(null);
            return;
          }
          setError(null);
          setSaving(true);
          const saving = renameOfflineNote(note.id, draft, subject);
          onSave(saving);
          void saving
            .then(() => {
              setDraft((current) => (current === draft ? null : current));
              requestOfflineSync();
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'The title could not be saved on this device.',
              );
            })
            .finally(() => {
              setSaving(false);
            });
        }}
      />
      {error ? (
        <Text as="p" variant="caption" role="alert">
          {error}
        </Text>
      ) : null}
    </div>
  );
}
