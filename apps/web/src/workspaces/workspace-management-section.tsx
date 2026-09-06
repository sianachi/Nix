import { workspaces as coreWorkspaces } from '@nix/api-client';
import { Blueprint, Button, Dialog, Field, Input, Select, Tag, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../components/states/status-panels';
import { useWorkspace } from './workspace-context';
import { useWorkspaceAdministration } from './use-workspace-administration';

type AssignableRole = 'owner' | 'editor' | 'viewer';

function formatBytes(value: number | string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${String(value)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 'bytes';
  for (const nextUnit of units) {
    amount /= 1024;
    unit = nextUnit;
    if (amount < 1024 || nextUnit === units[units.length - 1]) break;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

export function WorkspaceManagementSection(): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const context = useWorkspace();
  const { workspace } = context;
  const administration = useWorkspaceAdministration();
  const [name, setName] = useState(workspace.name);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [inviteePrincipalId, setInviteePrincipalId] = useState('');
  const [role, setRole] = useState<AssignableRole>('editor');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    | { readonly kind: 'remove'; readonly principalId: string; readonly name: string }
    | { readonly kind: 'leave' }
    | null
  >(null);
  const createRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      createRequest.current?.abort();
    },
    [],
  );

  async function createWorkspace(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> {
    event.preventDefault();
    if (newWorkspaceName.trim().length === 0) return;
    createRequest.current?.abort();
    const controller = new AbortController();
    createRequest.current = controller;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await client.execute(
        coreWorkspaces.createWorkspace(newWorkspaceName.trim()),
        {
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || createRequest.current !== controller) return;
      context.workspaceCreated(created);
      void navigate(`/w/${created.id}`);
    } catch {
      if (controller.signal.aborted) return;
      setCreateError('The workspace could not be created. Check the name and try again.');
    } finally {
      if (createRequest.current === controller) {
        createRequest.current = null;
        setCreating(false);
      }
    }
  }

  return (
    <section
      aria-labelledby="workspace-management-heading"
      aria-busy={administration.working || creating}
      className="flex max-w-4xl flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <Text id="workspace-management-heading" variant="h3" as="h2">
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

      {administration.mutationError === null ? null : (
        <Text role="alert" tone="muted">
          {administration.mutationError}
        </Text>
      )}
      <div aria-live="polite" aria-atomic="true">
        {administration.working ? (
          <Text tone="muted">Saving workspace changes…</Text>
        ) : administration.mutationNotice === null ? null : (
          <Text>{administration.mutationNotice}</Text>
        )}
      </div>

      {workspace.canRename ? (
        <form
          className="flex max-w-xl flex-col items-stretch gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void administration.rename(name.trim());
          }}
        >
          <Field label="Workspace name">
            {(control) => (
              <Input
                {...control}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </Field>
          <Button
            type="submit"
            variant="secondary"
            disabled={administration.working || name.trim().length === 0}
          >
            Rename
          </Button>
        </form>
      ) : null}

      <Blueprint className="flex max-w-xl flex-col gap-3 p-4">
        <Text variant="h4" as="h3">
          Create a shared workspace
        </Text>
        <form
          className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
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
            Create
          </Button>
        </form>
        {createError === null ? null : (
          <Text role="alert" tone="muted">
            {createError}
          </Text>
        )}
      </Blueprint>

      {!workspace.canManageMembers ? (
        <Text tone="muted">You can see this workspace, but you cannot manage its members.</Text>
      ) : (
        <>
          {administration.membersStatus === 'error' ||
          administration.membersStatus === 'partial' ||
          administration.invitationsStatus === 'error' ||
          administration.invitationsStatus === 'partial' ||
          administration.inviteesStatus === 'error' ||
          administration.inviteesStatus === 'partial' ? (
            <PartialNotice pending="Some workspace access information is unavailable. The available section remains usable." />
          ) : null}
          <Blueprint className="flex flex-col gap-3 p-4">
            <Text variant="h4" as="h3">
              Invite someone
            </Text>
            <Text variant="note" tone="muted">
              Select an existing Nix user. They receive provisional access immediately and decide
              whether to accept or decline the invitation.
            </Text>
            {administration.inviteesStatus === 'loading' ? (
              <LoadingPanel label="people available to invite" />
            ) : administration.inviteesStatus === 'error' ? (
              <ErrorPanel
                title="People could not be loaded"
                detail={administration.inviteesError ?? 'Try again.'}
                action={
                  <Button variant="secondary" onClick={administration.reload}>
                    Try again
                  </Button>
                }
              />
            ) : administration.inviteesStatus === 'partial' &&
              administration.invitees.length === 0 ? (
              <ErrorPanel
                title="Available people could not be checked"
                detail={administration.inviteesError ?? 'Some people may be unavailable.'}
                action={
                  <Button variant="secondary" onClick={administration.reload}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <>
                <form
                  className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void administration.invite(inviteePrincipalId, role).then((saved) => {
                      if (saved) setInviteePrincipalId('');
                    });
                  }}
                >
                  <Field label="Person">
                    {(control) => (
                      <Select
                        {...control}
                        required
                        disabled={administration.invitees.length === 0}
                        value={inviteePrincipalId}
                        onChange={(event) => {
                          setInviteePrincipalId(event.target.value);
                        }}
                      >
                        <option value="" disabled>
                          {administration.invitees.length === 0
                            ? 'No people available to invite'
                            : 'Select a person'}
                        </option>
                        {administration.invitees.map((invitee) => (
                          <option key={invitee.principalId} value={invitee.principalId}>
                            {invitee.displayName} ({invitee.email})
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Role">
                    {(control) => (
                      <Select
                        {...control}
                        value={role}
                        onChange={(event) => {
                          setRole(event.target.value as AssignableRole);
                        }}
                      >
                        {workspace.kind === 'shared' ? <option value="owner">Owner</option> : null}
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </Select>
                    )}
                  </Field>
                  <Button
                    type="submit"
                    disabled={administration.working || inviteePrincipalId.length === 0}
                  >
                    Invite
                  </Button>
                </form>
                {administration.invitees.length === 0 ? (
                  <Text tone="muted">Everyone who can be invited already has access.</Text>
                ) : null}
              </>
            )}
          </Blueprint>

          <div className="flex flex-col gap-2">
            <Text variant="h4" as="h3">
              Members
            </Text>
            {administration.membersStatus === 'loading' ? (
              <LoadingPanel label="workspace members" />
            ) : administration.membersStatus === 'error' ? (
              <ErrorPanel
                title="Members could not be loaded"
                detail={administration.membersError ?? 'Try again.'}
                action={
                  <Button variant="secondary" onClick={administration.reload}>
                    Try again
                  </Button>
                }
              />
            ) : administration.membersStatus === 'partial' &&
              administration.members.length === 0 ? (
              <ErrorPanel
                title="Member access could not be checked"
                detail={administration.membersError ?? 'Some member information is unavailable.'}
                action={
                  <Button variant="secondary" onClick={administration.reload}>
                    Try again
                  </Button>
                }
              />
            ) : administration.members.length === 0 ? (
              <Text tone="muted">No members are visible in this workspace.</Text>
            ) : (
              administration.members.map((member) => (
                <div
                  key={`${member.subjectType}:${member.subjectId}`}
                  className="flex flex-wrap items-center gap-2 bg-surface p-3 shadow-sm"
                >
                  <Text className="min-w-0 flex-1">{member.subjectDisplayName}</Text>
                  <Select
                    aria-label={`Role for ${member.subjectDisplayName}`}
                    value={member.role}
                    disabled={!member.canChangeRole || administration.working}
                    onChange={(event) =>
                      void administration.changeRole(
                        member.subjectId,
                        event.target.value as AssignableRole,
                      )
                    }
                    className="w-full sm:w-auto"
                  >
                    {member.assignableRoles.includes('owner') || member.role === 'owner' ? (
                      <option value="owner" disabled={!member.assignableRoles.includes('owner')}>
                        Owner
                      </option>
                    ) : null}
                    {member.role === 'commenter' ? (
                      <option value="commenter" disabled>
                        Commenter (legacy)
                      </option>
                    ) : null}
                    {member.assignableRoles.includes('editor') || member.role === 'editor' ? (
                      <option value="editor" disabled={!member.assignableRoles.includes('editor')}>
                        Editor
                      </option>
                    ) : null}
                    {member.assignableRoles.includes('viewer') || member.role === 'viewer' ? (
                      <option value="viewer" disabled={!member.assignableRoles.includes('viewer')}>
                        Viewer
                      </option>
                    ) : null}
                  </Select>
                  {member.canRemove ? (
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${member.subjectDisplayName}`}
                      disabled={administration.working}
                      onClick={() => {
                        setConfirmation({
                          kind: 'remove',
                          principalId: member.subjectId,
                          name: member.subjectDisplayName,
                        });
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Text variant="h4" as="h3">
              Invitations
            </Text>
            {administration.invitationsStatus === 'loading' ? (
              <LoadingPanel label="workspace invitations" />
            ) : administration.invitationsStatus === 'error' ? (
              <ErrorPanel
                title="Invitations could not be loaded"
                detail={administration.invitationsError ?? 'Try again.'}
                action={
                  <Button variant="secondary" onClick={administration.reload}>
                    Try again
                  </Button>
                }
              />
            ) : administration.invitationsStatus === 'partial' &&
              administration.invitations.length === 0 ? (
              <ErrorPanel
                title="Invitation history could not be checked"
                detail={
                  administration.invitationsError ?? 'Some invitation information is unavailable.'
                }
                action={
                  <Button variant="secondary" onClick={administration.reload}>
                    Try again
                  </Button>
                }
              />
            ) : administration.invitations.length === 0 ? (
              <Text tone="muted">No invitation history yet.</Text>
            ) : (
              administration.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-wrap items-center gap-2 bg-surface p-3 shadow-sm"
                >
                  <Text className="min-w-0 flex-1">{invitation.emailNormalized}</Text>
                  <Tag>{invitation.role}</Tag>
                  <Tag tone="muted">{invitation.status}</Tag>
                  {invitation.status === 'pending' ? (
                    <Button
                      variant="ghost"
                      aria-label={`Revoke invitation for ${invitation.emailNormalized}`}
                      disabled={administration.working}
                      onClick={() => void administration.revokeInvitation(invitation.id)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      )}

      <Blueprint className="flex flex-col gap-3 border border-divider p-4">
        <div>
          <Text variant="h4" as="h3">
            Workspace access
          </Text>
          <Text variant="note" tone="muted" className="mt-1 max-w-xl">
            Leaving removes your access and takes this workspace out of your workspace switcher.
            The workspace and its content stay available to its other members.
          </Text>
        </div>
        {workspace.canLeave ? (
          <Button
            variant="secondary"
            disabled={administration.working}
            onClick={() => {
              setConfirmation({ kind: 'leave' });
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

      <Dialog
        open={confirmation !== null}
        title={
          confirmation?.kind === 'remove' ? `Remove ${confirmation.name}?` : 'Leave workspace?'
        }
        onClose={() => {
          if (!administration.working) setConfirmation(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={administration.working}
              onClick={() => {
                setConfirmation(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={administration.working}
              onClick={() => {
                if (confirmation?.kind === 'remove') {
                  void administration.removeMember(confirmation.principalId).then((removed) => {
                    if (removed) setConfirmation(null);
                  });
                  return;
                }
                if (confirmation?.kind === 'leave') {
                  void administration.leave().then((left) => {
                    if (!left) return;
                    context.workspaceRemoved(workspace.id);
                    setConfirmation(null);
                    void navigate('/');
                  });
                }
              }}
            >
              {confirmation?.kind === 'remove' ? 'Remove member' : 'Leave workspace'}
            </Button>
          </>
        }
      >
        <Text>
          {confirmation?.kind === 'remove'
            ? `${confirmation.name} will lose access to this workspace.`
            : `You will lose access to ${workspace.name}.`}
        </Text>
      </Dialog>
    </section>
  );
}
