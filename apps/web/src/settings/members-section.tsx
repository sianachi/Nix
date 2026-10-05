import { Button, Table, Tag, Text } from '@nix/ui';
import type { ReactElement } from 'react';

import { ErrorPanel, PartialNotice } from '../components/states/status-panels';
import { useWorkspaceMembers, type WorkspaceMember } from './use-workspace-members';
import { formatDay } from './token-facts';

/**
 * Who holds a role in this workspace.
 *
 * A table rather than a list, because every row answers the same three questions - who, as what,
 * since when - and columns are how three answers per row stay scannable. The role is a `<Tag>`:
 * it is a category, not prose, and the tag grammar is what the rest of the product uses for one.
 *
 * **Empty is a real state with a real sentence.** A workspace whose members endpoint answers an
 * empty page is telling this caller something - membership is administered elsewhere for now -
 * and a blank table body would leave them to guess whether the screen is broken.
 */

const columns = [
  {
    key: 'name',
    header: 'Member',
    rowHeader: true,
    cell: (member: WorkspaceMember) => (
      <span className="inline-flex items-center gap-2">{member.subjectDisplayName}</span>
    ),
  },
  {
    key: 'role',
    header: 'Role',
    cell: (member: WorkspaceMember) => <Tag>{member.role}</Tag>,
  },
  {
    key: 'grantedAt',
    header: 'Member since',
    cell: (member: WorkspaceMember) => formatDay(member.grantedAt),
  },
] as const;

export function MembersSection(): ReactElement {
  const { status, members, truncated, error, reload } = useWorkspaceMembers();

  return (
    <section aria-labelledby="members-heading" className="flex flex-col gap-3">
      <Text id="members-heading" variant="h3" as="h2">
        Members
      </Text>
      <Text variant="note" tone="muted">
        Everyone who holds a role in this workspace. Roles live in the database, so this list is as
        current as the last load.
      </Text>

      {status === 'error' ? (
        <ErrorPanel
          title="The members could not be loaded"
          detail={error ?? 'Something went wrong reading the workspace members.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {truncated ? (
            <PartialNotice pending="Not every member is shown: the list stopped at its page bound. What is here is accurate; the count is not complete." />
          ) : null}
          <Table
            caption="The principals and groups holding a role in this workspace."
            columns={columns}
            rows={members}
            rowKey={(member) => `${member.subjectType}:${member.subjectId}:${member.role}`}
            loading={status === 'loading'}
            loadingMessage="Loading the workspace members."
            emptyMessage="Nobody holds a role in this workspace yet. Membership is granted by a tenant administrator."
          />
        </>
      )}
    </section>
  );
}
