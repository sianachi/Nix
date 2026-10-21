import type { WorkspaceCalendarLink, CalendarConnection, CalendarLink } from '@nix/api-client';
import { Button, Dialog, Icon, Menu, Select, Table, Text, type MenuEntry } from '@nix/ui';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { ErrorPanel } from '../../components/states/status-panels';
import {
  connectionTag,
  formatMoment,
  linkTag,
  providerName,
  RETURN_NOTICES,
} from './calendar-labels';
import { ConfirmDisconnectDialog } from './disconnect-dialog';
import { LinkCalendarDialog } from './link-calendar-dialog';
import { SyncLogDialog } from './sync-log-dialog';
import { UnlinkDialog } from './unlink-dialog';
import { useCalendarSync } from './use-calendar-sync';

/**
 * Calendar sync: the Google and Outlook accounts connected to this account, and the calendars
 * linked into the workspace.
 *
 * **A linked calendar is a container of ordinary items**, one per event. They are edited like any
 * other item and the change goes to the calendar, but they are removed in exactly two ways: at the
 * calendar itself, or by unlinking here. That is why the unlink dialog asks what should become of
 * them rather than deciding: the notes may hold work that the calendar never saw.
 *
 * **Unlinking never touches the external calendar.** Both choices say so, because "move to the
 * trash" next to a calendar's name reads as deleting the meetings.
 */

export function CalendarsSection(): ReactElement {
  const sync = useCalendarSync();
  const { status, providers, connections, links, othersLinks, error, reload } = sync;
  const location = useLocation();
  const [search, setSearch] = useSearchParams();

  // What the provider's consent screen sent back, read once and then taken out of the address:
  // left there it would be announced again on every reload and every return to this tab.
  // The provider returns with a full page load, so the value at mount is the only one there is.
  const returnStatus = search.get('calendar_status');
  const [returned] = useState<string | null>(() => RETURN_NOTICES[returnStatus ?? ''] ?? null);
  useEffect(() => {
    if (returnStatus === null) {
      return;
    }
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('calendar_status');
        return next;
      },
      { replace: true },
    );
  }, [returnStatus, setSearch]);

  /** The last refusal of a row action, shown above the tables. */
  const [notice, setNotice] = useState<string | null>(null);
  /** What the last row action did, when the tables alone would not show it. */
  const [done, setDone] = useState<string | null>(null);
  /** Whether a row action is in flight, so a second press cannot queue behind the first. */
  const [busy, setBusy] = useState(false);
  /** The link whose change to syncing both ways is waiting to be confirmed. */
  const [widening, setWidening] = useState<CalendarLink | null>(null);
  const [linking, setLinking] = useState<CalendarConnection | null>(null);
  const [unlinking, setUnlinking] = useState<CalendarLink | null>(null);
  const [unlinkingOthers, setUnlinkingOthers] = useState<WorkspaceCalendarLink | null>(null);
  const [disconnecting, setDisconnecting] = useState<CalendarConnection | null>(null);
  const [logFor, setLogFor] = useState<CalendarLink | null>(null);

  async function act(
    run: () => Promise<{ readonly refusal: string | null }>,
    success: string | null = null,
  ): Promise<void> {
    setNotice(null);
    setDone(null);
    setBusy(true);
    try {
      const { refusal } = await run();
      setNotice(refusal);
      setDone(refusal === null ? success : null);
    } finally {
      setBusy(false);
    }
  }

  const connectTo = (provider: string): Promise<{ readonly refusal: string | null }> =>
    sync.connect(provider, `${location.pathname}?tab=integrations`);

  function connectionActions(connection: CalendarConnection): readonly MenuEntry[] {
    return [
      connection.status === 'active'
        ? {
            label: 'Link a calendar',
            disabled: busy,
            onSelect: () => {
              setLinking(connection);
            },
          }
        : {
            label: 'Reconnect',
            disabled: busy,
            onSelect: () => {
              void act(() => connectTo(connection.provider));
            },
          },
      {
        label: 'Disconnect account',
        disabled: busy,
        destructive: true,
        onSelect: () => {
          setDisconnecting(connection);
        },
      },
    ];
  }

  function linkActions(link: CalendarLink): readonly MenuEntry[] {
    const actions: MenuEntry[] = [];
    if (link.status === 'active') {
      actions.push({
        label: 'Sync now',
        disabled: busy,
        onSelect: () => {
          void act(() => sync.sync(link.id), `A sync of ${link.name} has started.`);
        },
      });
    }
    if (link.status === 'active' || link.status === 'paused') {
      actions.push({
        label: link.status === 'active' ? 'Pause syncing' : 'Resume syncing',
        disabled: busy,
        onSelect: () => {
          void act(() =>
            sync.update(link, { status: link.status === 'active' ? 'paused' : 'active' }),
          );
        },
      });
    }
    actions.push(
      {
        label: 'View sync log',
        onSelect: () => {
          setLogFor(link);
        },
      },
      {
        label: 'Unlink calendar',
        disabled: busy,
        destructive: true,
        onSelect: () => {
          setUnlinking(link);
        },
      },
    );
    return actions;
  }

  const connectionColumns = [
    {
      key: 'account',
      header: 'Account',
      rowHeader: true,
      cell: (connection: CalendarConnection) => connection.accountEmail,
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (connection: CalendarConnection) => providerName(connection.provider),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (connection: CalendarConnection) => connectionTag(connection.status),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (connection: CalendarConnection) => (
        <Menu
          label={`Actions for ${connection.accountEmail}`}
          items={connectionActions(connection)}
        >
          {(trigger) => (
            <Button
              {...trigger}
              variant="icon"
              aria-label={`Actions for ${connection.accountEmail}`}
            >
              <Icon icon={MoreHorizontal} size="sm" />
            </Button>
          )}
        </Menu>
      ),
    },
  ] as const;

  const linkColumns = [
    {
      key: 'name',
      header: 'Calendar',
      rowHeader: true,
      cell: (link: CalendarLink) => link.name,
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (link: CalendarLink) => providerName(link.provider),
    },
    {
      key: 'direction',
      header: 'Direction',
      cell: (link: CalendarLink) => (
        <Select
          aria-label={`Direction of ${link.name}`}
          value={link.direction}
          disabled={busy}
          onChange={(event) => {
            // Narrowing to import-only is applied at once. Widening sends this workspace's edits
            // to the calendar, so it is confirmed first, with what that means said plainly.
            if (event.target.value === 'two_way') {
              setWidening(link);
              return;
            }
            void act(() => sync.update(link, { direction: event.target.value }));
          }}
        >
          <option value="two_way">Both ways</option>
          <option value="import_only">Import only</option>
        </Select>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (link: CalendarLink) => (
        <div className="flex flex-col gap-1">
          {linkTag(link)}
          <Text as="span" variant="note" tone="muted">
            Last synced {formatMoment(link.lastSyncedAt)}
          </Text>
          {link.lastError === null ? null : (
            <Text as="span" variant="note">
              {link.lastError}
            </Text>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (link: CalendarLink) => (
        <Menu label={`Actions for ${link.name}`} items={linkActions(link)}>
          {(trigger) => (
            <Button {...trigger} variant="icon" aria-label={`Actions for ${link.name}`}>
              <Icon icon={MoreHorizontal} size="sm" />
            </Button>
          )}
        </Menu>
      ),
    },
  ] as const;

  return (
    <section aria-labelledby="calendars-heading" className="flex flex-col gap-3">
      <Text id="calendars-heading" variant="h3" as="h2">
        Calendars
      </Text>
      <Text variant="note" tone="muted">
        Connect a Google or Outlook account, then link its calendars into this workspace. Each
        linked calendar becomes an item holding one note per event, and shows on the workspace
        calendar with everything else. Events are removed at the calendar or by unlinking here,
        never from the workspace tree.
      </Text>

      {returned === null ? null : (
        <Text variant="note" role="status">
          {returned}
        </Text>
      )}
      {notice === null ? null : (
        <Text variant="note" role="alert">
          {notice}
        </Text>
      )}
      {done === null ? null : (
        <Text variant="note" role="status">
          {done}
        </Text>
      )}

      {status === 'error' ? (
        <ErrorPanel
          title="Your calendars could not be loaded"
          detail={error ?? 'Something went wrong reading your calendar connections.'}
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
          <div className="flex flex-wrap gap-2">
            {providers.map((entry) => (
              <Button
                key={entry.provider}
                variant="secondary"
                disabled={!entry.available || busy}
                onClick={() => {
                  void act(() => connectTo(entry.provider));
                }}
              >
                Connect {providerName(entry.provider)}
              </Button>
            ))}
          </div>
          {providers.some((entry) => !entry.available) ? (
            <Text variant="note" tone="muted">
              A provider that cannot be chosen has not been set up on this server yet.
            </Text>
          ) : null}

          <div
            className="min-w-0 overflow-x-auto"
            role="region"
            aria-label="Calendar accounts table"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll account columns horizontally.
            tabIndex={0}
          >
            <Table
              caption="Accounts connected for calendar sync."
              columns={connectionColumns}
              rows={connections}
              rowKey={(connection) => connection.id}
              rowContextMenu={connectionActions}
              rowContextMenuLabel={(connection) => `Actions for ${connection.accountEmail}`}
              loading={status === 'loading'}
              loadingMessage="Loading your connected accounts."
              emptyMessage="No account is connected. Connect one to link its calendars."
            />
          </div>

          <Text variant="h4" as="h3" className="mt-3">
            Linked calendars
          </Text>
          <div
            className="min-w-0 overflow-x-auto"
            role="region"
            aria-label="Linked calendars table"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll calendar columns horizontally.
            tabIndex={0}
          >
            <Table
              caption="Calendars linked into your workspaces."
              columns={linkColumns}
              rows={links}
              rowKey={(link) => link.id}
              rowContextMenu={linkActions}
              rowContextMenuLabel={(link) => `Actions for ${link.name}`}
              loading={status === 'loading'}
              loadingMessage="Loading your linked calendars."
              emptyMessage="No calendar is linked yet."
            />
          </div>

          {/* Only drawn when there is something in it: Core fills it for somebody who manages the
              workspace and for nobody else, so an empty heading would promise a power most
              readers do not have. */}
          {othersLinks.length === 0 ? null : (
            <>
              <Text variant="h4" as="h3" className="mt-3">
                Linked by other members
              </Text>
              <Text variant="note" tone="muted">
                Calendars other members linked into this workspace. You manage the workspace, so you
                can unlink them; their items cannot be deleted while the link stands.
              </Text>
              <div
                className="min-w-0 overflow-x-auto"
                role="region"
                aria-label="Other members' calendars table"
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll calendar columns horizontally.
                tabIndex={0}
              >
                <Table
                  caption="Calendars other members linked into this workspace."
                  columns={
                    [
                      {
                        key: 'title',
                        header: 'Item',
                        rowHeader: true,
                        cell: (entry: WorkspaceCalendarLink) => entry.title || 'Untitled',
                      },
                      {
                        key: 'actions',
                        header: 'Actions',
                        cell: (entry: WorkspaceCalendarLink) => (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setUnlinkingOthers(entry);
                            }}
                          >
                            Unlink {entry.title || 'Untitled'}
                          </Button>
                        ),
                      },
                    ] as const
                  }
                  rows={othersLinks}
                  rowKey={(entry) => entry.containerItemId}
                  emptyMessage="No other member has linked a calendar here."
                />
              </div>
            </>
          )}
        </>
      )}

      {linking === null ? null : (
        <LinkCalendarDialog
          connection={linking}
          sync={sync}
          onClose={() => {
            setLinking(null);
          }}
        />
      )}

      {widening === null ? null : (
        <Dialog
          open
          title={`Sync ${widening.name} both ways?`}
          onClose={() => {
            setWidening(null);
          }}
          closeLabel="Keep it import only"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setWidening(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const link = widening;
                  setWidening(null);
                  void act(() => sync.update(link, { direction: 'two_way' }));
                }}
              >
                Sync both ways
              </Button>
            </>
          }
        >
          <Text variant="bodySmall">
            Changes made to these events in the workspace will be sent to the calendar. In a shared
            workspace that includes changes made by anybody who can edit it.
          </Text>
        </Dialog>
      )}

      {unlinking === null ? null : (
        <UnlinkDialog
          name={unlinking.name}
          unlink={(items) => sync.unlink(unlinking.id, items)}
          onClose={() => {
            setUnlinking(null);
          }}
        />
      )}

      {unlinkingOthers === null ? null : (
        <UnlinkDialog
          name={unlinkingOthers.title || 'Untitled'}
          unlink={(items) => sync.unlinkOthers(unlinkingOthers.containerItemId, items)}
          onClose={() => {
            setUnlinkingOthers(null);
          }}
        />
      )}

      {disconnecting === null ? null : (
        <ConfirmDisconnectDialog
          connection={disconnecting}
          sync={sync}
          onClose={() => {
            setDisconnecting(null);
          }}
        />
      )}

      {logFor === null ? null : (
        <SyncLogDialog
          link={logFor}
          sync={sync}
          onClose={() => {
            setLogFor(null);
          }}
        />
      )}
    </section>
  );
}
