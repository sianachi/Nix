import { Blueprint, Button, Field, Icon, Input, Select, Text } from '@nix/ui';
import { ArrowDown, ArrowUp, Pin, PinOff, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  addGroup,
  arrangeWorkspaces,
  assignToGroup,
  moveGroup,
  removeGroup,
  renameGroup,
  togglePin,
} from './arrangement';
import { useWorkspaceArrangement } from './use-workspace-arrangement';
import { useWorkspace } from './workspace-context';

/**
 * The person's own workspace groups and pins (requirements 4 and 5): create, rename, order and
 * remove groups, put each workspace in one group or none, and pin. Nothing here changes a
 * workspace, its members or who may open it; removing a group only ungroups what was in it.
 */
export function WorkspaceGroupsSection(): ReactNode {
  const { workspaces } = useWorkspace();
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const { arrangement, loading, saving, error, save } = useWorkspaceArrangement();
  const arranged = arrangeWorkspaces(active, arrangement);
  const [newGroupName, setNewGroupName] = useState('');
  const groupOf = (workspaceId: string): string =>
    arrangement.groups.find((group) => group.workspaceIds.includes(workspaceId))?.id ?? '';

  return (
    <section
      aria-labelledby="workspace-groups-heading"
      aria-busy={saving}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <Text id="workspace-groups-heading" variant="h4" as="h3">
          Workspace groups and pins
        </Text>
        <Text variant="note" tone="muted">
          How the workspace menu is arranged for you alone. Groups and pins change nothing about a
          workspace or who can open it; removing a group keeps every workspace in it.
        </Text>
      </div>
      {error === null ? null : (
        <Text role="alert" variant="note">
          {error}
        </Text>
      )}
      {loading ? (
        <Text variant="note" tone="muted" role="status">
          Loading your groups…
        </Text>
      ) : (
        <>
          <form
            className="flex max-w-xl flex-col items-stretch gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newGroupName.trim();
              if (name.length === 0) return;
              void save(addGroup(arrangement, name)).then((ok) => {
                if (ok) setNewGroupName('');
              });
            }}
          >
            <Field label="New group" className="min-w-0 flex-1">
              {(control) => (
                <Input
                  {...control}
                  value={newGroupName}
                  maxLength={80}
                  onChange={(event) => {
                    setNewGroupName(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="secondary"
              disabled={saving || newGroupName.trim().length === 0}
            >
              Add group
            </Button>
          </form>

          {arranged.groups.length === 0 ? (
            <Text variant="note" tone="muted">
              No groups yet. Workspaces are listed in one list until you add one.
            </Text>
          ) : (
            <ul aria-label="Workspace groups" className="flex flex-col gap-2">
              {arranged.groups.map((group, index) => (
                <li key={group.id}>
                  <Blueprint className="flex flex-wrap items-end gap-2 p-3">
                    <Field label="Group name" className="min-w-0 flex-1">
                      {(control) => (
                        <Input
                          {...control}
                          defaultValue={group.name}
                          maxLength={80}
                          onBlur={(event) => {
                            const name = event.currentTarget.value.trim();
                            if (name.length > 0 && name !== group.name) {
                              void save(renameGroup(arrangement, group.id, name));
                            }
                          }}
                        />
                      )}
                    </Field>
                    <Button
                      variant="icon"
                      aria-label={`Move ${group.name} up`}
                      disabled={saving || index === 0}
                      onClick={() => {
                        void save(moveGroup(arrangement, group.id, -1));
                      }}
                    >
                      <Icon icon={ArrowUp} size="sm" />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={`Move ${group.name} down`}
                      disabled={saving || index === arranged.groups.length - 1}
                      onClick={() => {
                        void save(moveGroup(arrangement, group.id, 1));
                      }}
                    >
                      <Icon icon={ArrowDown} size="sm" />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={`Remove group ${group.name}`}
                      disabled={saving}
                      onClick={() => {
                        void save(removeGroup(arrangement, group.id));
                      }}
                    >
                      <Icon icon={Trash2} size="sm" />
                    </Button>
                    <Text as="p" variant="caption" tone="muted" className="w-full">
                      {group.workspaces.length === 0
                        ? 'Empty. Choose this group beside a workspace below.'
                        : group.workspaces.map((entry) => entry.name).join(', ')}
                    </Text>
                  </Blueprint>
                </li>
              ))}
            </ul>
          )}

          <ul aria-label="Arrange workspaces" className="flex flex-col divide-y divide-divider">
            {active.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
                <Text as="span" variant="bodySmall" className="min-w-0 flex-1 truncate">
                  {entry.name}
                </Text>
                <Button
                  variant="ghost"
                  aria-pressed={arrangement.pinnedWorkspaceIds.includes(entry.id)}
                  disabled={saving}
                  onClick={() => {
                    void save(togglePin(arrangement, entry.id));
                  }}
                >
                  <Icon
                    icon={arrangement.pinnedWorkspaceIds.includes(entry.id) ? PinOff : Pin}
                    size="sm"
                  />
                  {arrangement.pinnedWorkspaceIds.includes(entry.id) ? 'Unpin' : 'Pin'}
                </Button>
                <Field label={`Group for ${entry.name}`} className="min-w-48">
                  {(control) => (
                    <Select
                      {...control}
                      value={groupOf(entry.id)}
                      disabled={saving || arrangement.groups.length === 0}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        void save(
                          assignToGroup(arrangement, entry.id, value.length === 0 ? null : value),
                        );
                      }}
                    >
                      <option value="">No group</option>
                      {arrangement.groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
