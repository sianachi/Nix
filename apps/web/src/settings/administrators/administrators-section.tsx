import { Button, Field, Input, Select, Table, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import { ErrorPanel } from '../../components/states/status-panels';
import { useWorkspaceAssignablePrincipals } from '../../workspaces/use-workspace-assignable-principals';
import { formatDay } from '../access-tokens/token-facts';
import { useCapabilities } from '../../session/capabilities-context';
import {
  SITE_APPROVERS,
  TENANT_ADMINS,
  usePeople,
  type Person,
  type PeopleSource,
} from './use-administrators';

/** Who can administer the tenant, and who can approve first publishes. Each block shows only to those it concerns. */
export function AdministratorsSection(): ReactElement {
  const { tenantAdministrator, siteApprover } = useCapabilities();
  return (
    <div className="flex min-w-0 max-w-4xl flex-col gap-8">
      {tenantAdministrator ? (
        <PeopleBlock
          id="tenant-admins"
          title="Tenant administrators"
          description="People who manage roles and groups across the whole tenant. There is always at least one."
          source={TENANT_ADMINS}
        />
      ) : null}
      {siteApprover ? (
        <PeopleBlock
          id="site-approvers"
          title="Site approvers"
          description="People who decide a site’s first publish. Those set in the deployment’s configuration cannot be removed here."
          source={SITE_APPROVERS}
          showSource
        />
      ) : null}
    </div>
  );
}

function PeopleBlock({
  id,
  title,
  description,
  source,
  showSource = false,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly source: PeopleSource;
  readonly showSource?: boolean;
}): ReactElement {
  const { status, people, error, actionError, busyId, reload, add, remove } = usePeople(source);

  const columns = [
    { key: 'name', header: 'Person', rowHeader: true, cell: (person: Person) => person.name },
    ...(showSource
      ? [
          {
            key: 'source',
            header: 'Source',
            cell: (person: Person) => (person.configured ? 'Configured' : 'Granted'),
          },
        ]
      : []),
    {
      key: 'since',
      header: 'Since',
      cell: (person: Person) => (person.since === null ? '' : formatDay(person.since)),
    },
    {
      key: 'actions',
      header: 'Remove',
      cell: (person: Person) =>
        person.configured ? null : (
          <Button
            variant="secondary"
            disabled={busyId !== null}
            aria-label={`Remove ${person.name} from ${title}`}
            onClick={() => {
              void remove(person.id);
            }}
          >
            Remove
          </Button>
        ),
    },
  ];

  return (
    <section aria-labelledby={`${id}-heading`} className="flex min-w-0 flex-col gap-3">
      <Text id={`${id}-heading`} variant="h3" as="h2">
        {title}
      </Text>
      <Text variant="note" tone="muted">
        {description}
      </Text>

      {status === 'error' ? (
        <ErrorPanel
          title={`${title} could not be loaded`}
          detail={error ?? 'Something went wrong reading the list.'}
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
          <div
            className="min-w-0 overflow-x-auto"
            role="region"
            aria-label={`${title} table`}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll the table horizontally.
            tabIndex={0}
          >
            <Table
              caption={title}
              columns={columns}
              rows={people}
              rowKey={(person) => person.id}
              loading={status === 'loading'}
              loadingMessage={`Loading ${title.toLocaleLowerCase()}.`}
              emptyMessage="Nobody is listed yet."
            />
          </div>
          <PersonPicker
            label={title}
            taken={people}
            disabled={busyId !== null}
            onAdd={(personId) => add(personId)}
          />
          {actionError === null ? null : (
            <Text role="alert" variant="note">
              {actionError}
            </Text>
          )}
        </>
      )}
    </section>
  );
}

/** Search the workspace's people and add one who is not already listed. */
function PersonPicker({
  label,
  taken,
  disabled,
  onAdd,
}: {
  readonly label: string;
  readonly taken: readonly Person[];
  readonly disabled: boolean;
  readonly onAdd: (id: string) => Promise<void>;
}): ReactElement {
  const directory = useWorkspaceAssignablePrincipals();
  const [chosen, setChosen] = useState('');
  const candidates = directory.principals.filter(
    (principal) => !taken.some((person) => person.id === principal.principalId),
  );

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Search people" className="w-56">
        {(control) => (
          <Input
            {...control}
            value={directory.query}
            onChange={(event) => {
              directory.setQuery(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={`Add to ${label}`} className="w-64">
        {(control) => (
          <Select
            {...control}
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            <option value="">Choose a person</option>
            {candidates.map((principal) => (
              <option key={principal.principalId} value={principal.principalId}>
                {principal.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button
        disabled={disabled || chosen === ''}
        aria-label={`Add to ${label}`}
        onClick={() => {
          void onAdd(chosen).then(() => {
            setChosen('');
          });
        }}
      >
        Add
      </Button>
    </div>
  );
}
