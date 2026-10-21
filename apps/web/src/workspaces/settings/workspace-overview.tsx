import { Blueprint, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatBytes, type CurrentWorkspace } from './shared';

export function WorkspaceOverview(props: { readonly workspace: CurrentWorkspace }): ReactNode {
  const { workspace } = props;
  return (
    <>
      <div className="flex flex-col gap-2">
        <Text id="workspace-management-heading" variant="h3" as="h2" className="break-words">
          {workspace.name}
        </Text>
        <Text variant="note" tone="muted">
          {workspace.kind === 'shared' ? 'Shared workspace' : 'Personal workspace'}
          {' · '}
          Created {new Date(workspace.createdAt).toLocaleDateString()}
        </Text>
      </div>

      <Blueprint className="grid gap-4 p-4 sm:grid-cols-3">
        <div>
          <Text variant="kicker">Workspace type</Text>
          <Text className="mt-1">{workspace.kind === 'shared' ? 'Shared' : 'Personal'}</Text>
        </div>
        <div>
          <Text variant="kicker">Version history</Text>
          <Text className="mt-1">{workspace.versionRetentionDays} days</Text>
        </div>
        <div>
          <Text variant="kicker">Storage allowance</Text>
          <Text className="mt-1">{formatBytes(workspace.storageQuotaBytes)}</Text>
        </div>
      </Blueprint>
    </>
  );
}
