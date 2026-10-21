import { Button, Tag, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { ErrorPanel, LoadingPanel } from '../../components/states/status-panels';
import type { Administration } from './shared';

export function InvitationsList(props: { readonly administration: Administration }): ReactNode {
  const { administration } = props;
  return (
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
          detail={administration.invitationsError ?? 'Some invitation information is unavailable.'}
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
            className="flex flex-col gap-2 bg-surface p-3 shadow-sm sm:flex-row sm:items-center"
          >
            <Text className="min-w-0 flex-1 break-all">{invitation.emailNormalized}</Text>
            <div className="flex flex-wrap items-center gap-2">
              <Tag>{invitation.role}</Tag>
              <Tag tone="muted">{invitation.status}</Tag>
            </div>
            {invitation.status === 'pending' ? (
              <Button
                variant="secondary"
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
  );
}
