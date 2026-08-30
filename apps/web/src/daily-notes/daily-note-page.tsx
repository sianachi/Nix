import { Button, Text } from '@nix/ui';
import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { dailyNoteLabel, localDailyNoteDate, parseDailyNoteDate } from './daily-note';

export function DailyNotePage(): ReactNode {
  const { date } = useParams();
  const canonical = date === undefined ? localDailyNoteDate() : parseDailyNoteDate(date);
  const client = useApiClient();
  const { workspaceId, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace.canUseDailyNotes) return;
    if (canonical === null || date === undefined) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      setError(null);
    });
    void client
      .execute(coreWorkspaces.openDailyNote(workspaceId, canonical), {
        signal: controller.signal,
      })
      .then(({ itemId }) => {
        if (controller.signal.aborted) return;
        void navigate(`../../?item=${encodeURIComponent(itemId)}`, {
          replace: true,
          relative: 'path',
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setError(
          isNixApiError(reason)
            ? (reason.detail ?? 'This daily note could not be opened.')
            : 'This daily note could not be opened. Check the connection and try again.',
        );
      });
    return () => {
      controller.abort();
    };
  }, [attempt, canonical, client, date, navigate, workspace.canUseDailyNotes, workspaceId]);

  if (!workspace.canUseDailyNotes) {
    return <Navigate replace to={`/w/${workspaceId}`} />;
  }

  if (date === undefined) return <Navigate replace to={localDailyNoteDate()} />;
  if (canonical === null) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Text variant="h2" as="h1">
          Daily note not found
        </Text>
        <Text tone="muted">The date in this address is not a calendar day.</Text>
      </section>
    );
  }
  if (error !== null) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Text variant="h2" as="h1">
          Daily note could not be opened
        </Text>
        <Text role="alert" tone="muted">
          {error}
        </Text>
        <Button
          variant="secondary"
          onClick={() => {
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </section>
    );
  }
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <Text variant="h2" as="h1">
        Opening daily note
      </Text>
      <Text tone="muted">{dailyNoteLabel(canonical)}</Text>
    </section>
  );
}
