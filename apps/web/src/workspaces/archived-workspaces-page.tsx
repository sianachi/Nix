import { Blueprint, Button, Field, Input, Text } from '@nix/ui';
import { workspaces as coreWorkspaces } from '@nix/api-client';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { ErrorPanel, LoadingPanel } from '../components/states/status-panels';
import { useAccessibleWorkspaces } from './workspace-context';

/** Lists workspaces outside everyday navigation so archived work remains recoverable. */
export function ArchivedWorkspacesPage(): ReactNode {
  const client = useApiClient();
  const { status, workspaces, error, reload, workspaceUpdated } = useAccessibleWorkspaces();
  const navigate = useNavigate();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const archived = workspaces.filter((workspace) => workspace.lifecycleState === 'archived');

  async function restore(workspaceId: string): Promise<void> {
    setRestoring(workspaceId);
    setMutationError(null);
    try {
      const restored = await client.execute(coreWorkspaces.restoreWorkspace(workspaceId));
      workspaceUpdated(restored);
      reload();
    } catch {
      setMutationError('The workspace could not be restored. Try again.');
    } finally {
      setRestoring(null);
    }
  }

  async function purge(workspaceId: string): Promise<void> {
    setPurging(workspaceId);
    setMutationError(null);
    try {
      await client.execute(coreWorkspaces.purgeWorkspace(workspaceId));
      const current = workspaces.find((workspace) => workspace.id === workspaceId);
      if (current) workspaceUpdated({ ...current, lifecycleState: 'purging' });
      reload();
      setConfirmation(null);
    } catch {
      setMutationError('The workspace could not be permanently deleted. Try again.');
    } finally {
      setPurging(null);
    }
  }

  async function createWorkspace(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
    event.preventDefault();
    const name = newWorkspaceName.trim();
    if (name.length === 0) return;

    setCreating(true);
    setMutationError(null);
    try {
      const created = await client.execute(coreWorkspaces.createWorkspace(name));
      workspaceUpdated(created);
      void navigate(`/w/${created.id}`);
    } catch {
      setMutationError('The workspace could not be created. Check the name and try again.');
    } finally {
      setCreating(false);
    }
  }

  if (status === 'loading') return <LoadingPanel label="archived workspaces" />;
  if (status === 'error') {
    return (
      <ErrorPanel
        title="Archived workspaces could not be loaded"
        detail={error ?? 'Try again.'}
        action={<Button variant="secondary" onClick={reload}>Try again</Button>}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Text variant="h2" as="h1">Archived workspaces</Text>
          <Text variant="note" tone="muted" className="mt-1 max-w-2xl">
            Archived workspaces are out of everyday navigation. Restore one to make it available again.
          </Text>
        </div>
        <Link to="/" className="text-sm text-accent-text underline">Back to workspaces</Link>
      </div>

      {mutationError === null ? null : <Text role="alert">{mutationError}</Text>}

      {archived.length === 0 ? (
        <Blueprint className="flex flex-col gap-3 p-4">
          <Text>No archived workspaces.</Text>
          <Text variant="note" tone="muted">
            Create a shared workspace to continue working.
          </Text>
          <form
            className="flex max-w-xl flex-col items-stretch gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              void createWorkspace(event);
            }}
          >
            <Field label="New workspace name">
              {(control) => (
                <Input
                  {...control}
                  value={newWorkspaceName}
                  onChange={(event) => {
                    setNewWorkspaceName(event.target.value);
                  }}
                />
              )}
            </Field>
            <Button type="submit" disabled={creating || newWorkspaceName.trim().length === 0}>
              {creating ? 'Creating…' : 'Create workspace'}
            </Button>
          </form>
        </Blueprint>
      ) : (
        <div className="flex flex-col gap-3">
          {archived.map((workspace) => (
            <Blueprint key={workspace.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <Text>{workspace.name}</Text>
                <Text variant="note" tone="muted">
                  Archived {workspace.archivedAt ? new Date(workspace.archivedAt).toLocaleDateString() : 'recently'}
                </Text>
              </div>
              <Button
                variant="secondary"
                disabled={restoring !== null || purging !== null}
                onClick={() => void restore(workspace.id)}
              >
                {restoring === workspace.id ? 'Restoring…' : 'Restore workspace'}
              </Button>
              <Button
                variant="secondary"
                disabled={restoring !== null || purging !== null}
                onClick={() => {
                  setConfirmation(workspace.id);
                }}
              >
                Delete permanently
              </Button>
              {confirmation === workspace.id ? (
                <div className="w-full border-t border-divider pt-3">
                  <Text variant="note" tone="muted">
                    This permanently deletes the workspace, its content, and its stored files. It cannot be undone.
                  </Text>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={purging !== null}
                      onClick={() => {
                        setConfirmation(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button disabled={purging !== null} onClick={() => void purge(workspace.id)}>
                      {purging === workspace.id ? 'Deleting…' : 'Delete permanently'}
                    </Button>
                  </div>
                </div>
              ) : null}
            </Blueprint>
          ))}
        </div>
      )}
    </main>
  );
}
