import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatBytes, type CurrentWorkspace } from './shared';

export function WorkspaceOverview(props: { readonly workspace: CurrentWorkspace }): ReactNode {
  const { workspace } = props;
  return (
    <div className="flex flex-col gap-1">
      <Text id="workspace-management-heading" variant="h3" as="h2" className="break-words">
        {workspace.name}
      </Text>
      <Text variant="note" tone="muted">
        {workspace.kind === 'shared' ? 'Shared workspace' : 'Personal workspace'}
        {' · '}
        {workspace.versionRetentionDays} days of history
        {' · '}
        {formatBytes(workspace.storageQuotaBytes)} storage
        {' · '}
        Created {new Date(workspace.createdAt).toLocaleDateString()}
      </Text>
    </div>
  );
}
