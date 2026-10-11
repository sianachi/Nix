import { Text } from '@nix/ui';
import { within } from '@testing-library/dom';
import { useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { AuthProvider } from '../auth/auth-provider';
import { useSessionStore } from '../auth/session-store';
import { clearBodyCache, openBodyCache } from '../editor/body-cache';
import { clearDrafts } from '../editor/draft-journal';
import {
  clearOfflineData,
  createOfflineNote,
  rememberOfflineAccount,
  saveOfflineWorkspaces,
  setOfflineProgress,
} from './offline-store';
import { OfflineNotesPage } from './offline-notes-page';
import { OfflineStatus } from './offline-status';

export default { title: 'Nix/Offline notes', parameters: { layout: 'fullscreen' } };

function Fixture({ downloading = false }: { readonly downloading?: boolean }): ReactNode {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const isActive = (): boolean => active;
    void (async () => {
      const profile = { subject: 'offline-story', name: 'Writing account', email: null };
      const workspaceId = '00000000-0000-4000-8000-000000000001';
      await clearOfflineData();
      await clearDrafts();
      await clearBodyCache();
      await openBodyCache(profile.subject);
      await rememberOfflineAccount(profile);
      await saveOfflineWorkspaces([
        {
          id: workspaceId,
          name: 'Personal writing',
          kind: 'personal',
          lifecycleState: 'active',
          createdAt: '2026-10-11T00:00:00Z',
          archivedAt: null,
          versionRetentionDays: 30,
          storageQuotaBytes: 0,
          canRename: true,
          canManageMembers: false,
          canLeave: false,
          canUseDailyNotes: true,
          pendingInvitationId: null,
        },
      ]);
      const parent = await createOfflineNote(workspaceId, null, 'Writing plans');
      await createOfflineNote(workspaceId, parent.id, 'Observations from the train');
      await createOfflineNote(
        workspaceId,
        null,
        'A note with a longer title to review on a small phone',
      );
      setOfflineProgress(
        downloading ? { status: 'downloading', completed: 3, total: 18 } : { status: 'offline' },
      );
      if (!isActive()) return;
      useSessionStore.setState({
        status: 'authenticated',
        profile,
        error: null,
        unreachable: null,
      });
      setReady(true);
    })().catch((cause: unknown) => {
      if (isActive())
        setError(cause instanceof Error ? cause.message : 'The story could not load.');
    });
    return () => {
      active = false;
    };
  }, [downloading]);
  if (error)
    return (
      <Text variant="note" role="alert">
        {error}
      </Text>
    );
  if (!ready)
    return (
      <Text variant="note" role="status">
        Preparing saved notes…
      </Text>
    );
  return (
    <MemoryRouter initialEntries={['/offline']}>
      <AuthProvider>{downloading ? <OfflineStatus /> : <OfflineNotesPage />}</AuthProvider>
    </MemoryRouter>
  );
}

export const SavedNotes = {
  render: (): ReactNode => <Fixture />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('navigation', { name: 'Saved notes' });
  },
};
export const DarkSavedNotes = { ...SavedNotes, globals: { ground: 'dark' } };
export const NewNote = {
  render: (): ReactNode => <Fixture />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByRole('navigation', { name: 'Saved notes' });
    canvas.getByRole('button', { name: 'New note' }).click();
    await within(document.body).findByRole('dialog', { name: 'New note' });
  },
};
export const Downloading = {
  render: (): ReactNode => <Fixture downloading />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('complementary', { name: 'Offline notes status' });
  },
};
export const CollapsedStatus = {
  render: (): ReactNode => <Fixture downloading />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const collapse = await canvas.findByRole('button', { name: 'Collapse offline sync status' });
    collapse.click();
    await canvas.findByRole('button', { name: 'Show offline sync status' });
  },
};
export const CollapsedError = {
  ...CollapsedStatus,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await CollapsedStatus.play({ canvasElement });
    setOfflineProgress({
      status: 'error',
      error: 'Storage is full. Pending edits remain saved on this device.',
    });
    await within(canvasElement).findByRole('alert');
  },
};
