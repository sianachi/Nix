import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { Administration, Confirmation, CurrentWorkspace } from './shared';

/** Leaving and archiving end everyday use of the workspace, so they sit apart, last, behind a rule. */
export function LeaveArchiveSection(props: {
  readonly workspace: CurrentWorkspace;
  readonly administration: Administration;
  readonly onConfirm: (confirmation: Confirmation) => void;
}): ReactNode {
  const { workspace, administration } = props;
  return (
    <section
      aria-labelledby="workspace-leave-archive-heading"
      className="flex max-w-2xl flex-col gap-4 border-t border-divider pt-6"
    >
      <div className="flex flex-col gap-1">
        <Text id="workspace-leave-archive-heading" variant="h3" as="h2">
          Leave or archive
        </Text>
        <Text variant="note" tone="muted">
          Both ask you to confirm first.
        </Text>
      </div>
      <div className="flex flex-col gap-2">
        <Text variant="h4" as="h3">
          Workspace access
        </Text>
        <Text variant="note" tone="muted">
          Leaving takes this workspace out of your switcher; others keep it.
        </Text>
        {workspace.canLeave ? (
          <Button
            variant="secondary"
            className="self-start"
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
      </div>
      {workspace.canRename ? (
        <div className="flex flex-col gap-2">
          <Text variant="h4" as="h3">
            Archive workspace
          </Text>
          <Text variant="note" tone="muted">
            Hides it from everyday navigation; restore it from Archived workspaces.
          </Text>
          <Button
            variant="secondary"
            className="self-start"
            disabled={administration.working}
            onClick={() => {
              props.onConfirm({ kind: 'archive' });
            }}
          >
            Archive workspace
          </Button>
        </div>
      ) : null}
    </section>
  );
}
