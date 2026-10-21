import { Blueprint, Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { Administration, Confirmation, CurrentWorkspace } from './shared';

export function LeaveArchiveSection(props: {
  readonly workspace: CurrentWorkspace;
  readonly administration: Administration;
  readonly onConfirm: (confirmation: Confirmation) => void;
}): ReactNode {
  const { workspace, administration } = props;
  return (
    <>
      <Blueprint className="flex flex-col gap-3 border border-divider p-4">
        <div>
          <Text variant="h4" as="h3">
            Workspace access
          </Text>
          <Text variant="note" tone="muted" className="mt-1 max-w-xl">
            Leaving removes your access and takes this workspace out of your workspace switcher. The
            workspace and its content stay available to its other members.
          </Text>
        </div>
        {workspace.canLeave ? (
          <Button
            variant="secondary"
            disabled={administration.working}
            onClick={() => {
              props.onConfirm({ kind: 'leave' });
            }}
          >
            Leave workspace
          </Button>
        ) : (
          <Text variant="note" tone="muted">
            You cannot leave this workspace.
          </Text>
        )}
      </Blueprint>

      {workspace.canRename ? (
        <Blueprint className="flex flex-col gap-3 border border-divider p-4">
          <div>
            <Text variant="h4" as="h3">
              Archive workspace
            </Text>
            <Text variant="note" tone="muted" className="mt-1 max-w-xl">
              Archiving hides this workspace from everyday navigation without removing its members
              or content. You can restore it from Archived workspaces.
            </Text>
          </div>
          <Button
            variant="secondary"
            disabled={administration.working}
            onClick={() => {
              props.onConfirm({ kind: 'archive' });
            }}
          >
            Archive workspace
          </Button>
        </Blueprint>
      ) : null}
    </>
  );
}
