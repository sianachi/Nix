import { Select, Text } from '@nix/ui';
import type { ChangeEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useWorkspace } from './workspace-context';

export function WorkspaceSwitcher(): ReactNode {
  const navigate = useNavigate();
  const { workspace, workspaces } = useWorkspace();

  function switchWorkspace(event: ChangeEvent<HTMLSelectElement>): void {
    const target = workspaces.find((entry) => entry.id === event.currentTarget.value);
    if (target === undefined || target.id === workspace.id) return;

    // A workspace change deliberately starts at the target workspace root. Item, view, filter,
    // split and pane parameters name server state in the workspace being left and must never be
    // replayed against another workspace merely because their identifiers happen to parse.
    void navigate(`/w/${target.id}`);
  }

  return (
    <label className="flex min-w-0 flex-1 items-center gap-2">
      <Text variant="caption" as="span" tone="muted" className="sr-only">
        Workspace
      </Text>
      <Select
        aria-label="Workspace"
        value={workspace.id}
        onChange={switchWorkspace}
        className="min-w-0 w-full max-w-full sm:max-w-[24ch]"
      >
        {workspaces.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
