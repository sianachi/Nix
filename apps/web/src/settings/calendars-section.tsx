import type {
  WorkspaceCalendarLink,
  CalendarConnection,
  CalendarLink,
  CalendarSyncLogEntry,
  ExternalCalendar,
} from '@nix/api-client';
import { Button, Dialog, Field, Input, Select, Table, Tag, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { ErrorPanel } from '../components/states/status-panels';
import { useWorkspace } from '../workspaces/workspace-context';
import { useCalendarSync, type CalendarSyncState } from './use-calendar-sync';

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

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  google: 'Google Calendar',
  microsoft: 'Outlook',
};

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** What came back from the provider's consent screen, read from the address it returned to. */
const RETURN_NOTICES: Readonly<Record<string, string>> = {
  connected: 'The account is connected. Link one of its calendars to start syncing.',
  cancelled: 'Connecting was cancelled. Nothing was changed.',
  failed: 'The account could not be connected. Try again.',
};

function connectionTag(status: string): ReactNode {
  if (status === 'active') {
    return <Tag tone="accent">Connected</Tag>;
  }
  return (
    <Tag tone="muted">{status === 'needs_reauth' ? 'Needs reconnecting' : 'Disconnected'}</Tag>
  );
}

function linkTag(link: CalendarLink): ReactNode {
  if (link.status === 'active') {
    return <Tag tone="accent">Syncing</Tag>;
  }
  if (link.status === 'paused') {
    return <Tag tone="muted">Paused</Tag>;
  }
  return <Tag tone="muted">{link.status === 'error' ? 'Failing' : 'Stopped'}</Tag>;
}

function formatMoment(value: string | null): string {
  return value === null ? 'never' : new Date(value).toLocaleString();
}

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
        <div className="flex flex-wrap gap-2">
          {connection.status === 'active' ? (
            <Button
              variant="ghost"
              onClick={() => {
                setLinking(connection);
              }}
            >
              Link a calendar from {connection.accountEmail}
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void act(() => connectTo(connection.provider));
              }}
            >
              Reconnect {connection.accountEmail}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setDisconnecting(connection);
            }}
          >
            Disconnect {connection.accountEmail}
          </Button>
        </div>
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
        <div className="flex flex-wrap gap-2">
          {link.status === 'active' ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void act(() => sync.sync(link.id), `A sync of ${link.name} has started.`);
              }}
            >
              Sync {link.name} now
            </Button>
          ) : null}
          {link.status === 'active' || link.status === 'paused' ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void act(() =>
                  sync.update(link, { status: link.status === 'active' ? 'paused' : 'active' }),
                );
              }}
            >
              {link.status === 'active' ? `Pause ${link.name}` : `Resume ${link.name}`}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              setLogFor(link);
            }}
          >
            Sync log of {link.name}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setUnlinking(link);
            }}
          >
            Unlink {link.name}
          </Button>
        </div>
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

          <Table
            caption="Accounts connected for calendar sync."
            columns={connectionColumns}
            rows={connections}
            rowKey={(connection) => connection.id}
            loading={status === 'loading'}
            loadingMessage="Loading your connected accounts."
            emptyMessage="No account is connected. Connect one to link its calendars."
          />

          <Text variant="h4" as="h3" className="mt-3">
            Linked calendars
          </Text>
          <Table
            caption="Calendars linked into your workspaces."
            columns={linkColumns}
            rows={links}
            rowKey={(link) => link.id}
            loading={status === 'loading'}
            loadingMessage="Loading your linked calendars."
            emptyMessage="No calendar is linked yet."
          />

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

interface LinkCalendarDialogProps {
  readonly connection: CalendarConnection;
  readonly sync: CalendarSyncState;
  readonly onClose: () => void;
}

/** Picks one of the account's calendars and creates the container it will be mirrored into. */
function LinkCalendarDialog({ connection, sync, onClose }: LinkCalendarDialogProps): ReactElement {
  const { workspaceId, workspace } = useWorkspace();
  const { calendarsOf } = sync;

  const [calendars, setCalendars] = useState<readonly ExternalCalendar[] | null>(null);
  const [calendarId, setCalendarId] = useState('');
  const [title, setTitle] = useState('');
  const [direction, setDirection] = useState('two_way');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    let current = true;
    void calendarsOf(connection.id).then((listed) => {
      if (!current) {
        return;
      }
      setCalendars(listed.calendars);
      setRefusal(listed.refusal);
      const first = listed.calendars.find((entry) => entry.primary) ?? listed.calendars[0];
      if (first !== undefined) {
        setCalendarId(first.id);
        setTitle(first.name);
        setDirection(first.readOnly ? 'import_only' : 'two_way');
      }
    });
    return () => {
      current = false;
    };
  }, [calendarsOf, connection.id]);

  const chosen = calendars?.find((entry) => entry.id === calendarId) ?? null;

  async function submit(): Promise<void> {
    if (chosen === null || title.trim() === '') {
      setRefusal('Choose a calendar and give its item a name.');
      return;
    }
    setInFlight(true);
    setRefusal(null);
    try {
      const outcome = await sync.link({
        connectionId: connection.id,
        externalCalendarId: chosen.id,
        workspaceId,
        title: title.trim(),
        direction,
      });
      if (outcome.refusal !== null) {
        setRefusal(outcome.refusal);
        return;
      }
      onClose();
    } finally {
      setInFlight(false);
    }
  }

  return (
    <Dialog
      open
      title={`Link a calendar from ${connection.accountEmail}`}
      onClose={() => {
        if (!inFlight) {
          onClose();
        }
      }}
      closeLabel="Close without linking"
      actions={
        <>
          <Button variant="secondary" disabled={inFlight} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={inFlight || chosen === null}
            onClick={() => {
              void submit();
            }}
          >
            {inFlight ? 'Linking the calendar' : 'Link calendar'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {calendars === null ? (
          <Text variant="note" role="status">
            Reading the account&apos;s calendars.
          </Text>
        ) : (
          <>
            <Field label="Calendar">
              {(control) => (
                <Select
                  {...control}
                  value={calendarId}
                  onChange={(event) => {
                    const next = calendars.find((entry) => entry.id === event.target.value);
                    setCalendarId(event.target.value);
                    if (next !== undefined) {
                      setTitle(next.name);
                      setDirection(next.readOnly ? 'import_only' : direction);
                    }
                  }}
                >
                  {calendars.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.readOnly ? ' (read-only)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Item name"
              hint={`A new item with this name is created in ${workspace.name} to hold the events.`}
            >
              {(control) => (
                <Input
                  {...control}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Direction"
              hint={
                chosen?.readOnly === true
                  ? 'This calendar cannot be written to, so it can only be imported.'
                  : 'Both ways sends the changes you make here to the calendar.'
              }
            >
              {(control) => (
                <Select
                  {...control}
                  value={direction}
                  disabled={chosen?.readOnly === true}
                  onChange={(event) => {
                    setDirection(event.target.value);
                  }}
                >
                  <option value="two_way">Both ways</option>
                  <option value="import_only">Import only</option>
                </Select>
              )}
            </Field>
            {direction === 'two_way' && workspace.kind !== 'personal' ? (
              <Text variant="note">
                {workspace.name} is shared. Anybody who can edit it will be able to change events in
                your calendar through this link.
              </Text>
            ) : null}
          </>
        )}
        {refusal === null ? null : (
          <Text variant="note" role="alert">
            {refusal}
          </Text>
        )}
      </div>
    </Dialog>
  );
}

interface UnlinkDialogProps {
  /** What the calendar is called on this screen. */
  readonly name: string;

  /** Performs the unlink: the caller's own link, or another member's on a manager's authority. */
  readonly unlink: (items: 'keep' | 'trash') => Promise<{ readonly refusal: string | null }>;
  readonly onClose: () => void;
}

/** Asks what should become of a linked calendar's notes, then unlinks it. */
function UnlinkDialog({ name, unlink: run, onClose }: UnlinkDialogProps): ReactElement {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  async function unlink(items: 'keep' | 'trash'): Promise<void> {
    setInFlight(true);
    setRefusal(null);
    try {
      const outcome = await run(items);
      if (outcome.refusal !== null) {
        // The dialog stays open over a failure: closing it would report an unlink that never
        // happened.
        setRefusal(outcome.refusal);
        return;
      }
      onClose();
    } finally {
      setInFlight(false);
    }
  }

  return (
    <Dialog
      open
      title={`Unlink ${name}?`}
      onClose={() => {
        if (!inFlight) {
          onClose();
        }
      }}
      closeLabel="Keep the link"
      actions={
        <>
          <Button variant="secondary" disabled={inFlight} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={inFlight}
            onClick={() => {
              void unlink('trash');
            }}
          >
            {inFlight ? 'Unlinking' : 'Unlink and move notes to trash'}
          </Button>
          <Button
            disabled={inFlight}
            onClick={() => {
              void unlink('keep');
            }}
          >
            {inFlight ? 'Unlinking' : 'Unlink and keep notes'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Text variant="bodySmall">
          Syncing stops either way, and nothing is removed from the calendar itself. Choose what
          happens to the notes this link created in the workspace.
        </Text>
        <Text variant="bodySmall">
          Kept notes become ordinary items you can edit and delete. Trashed notes can be restored
          from the trash.
        </Text>
        {refusal === null ? null : (
          <Text variant="note" role="alert">
            {refusal}
          </Text>
        )}
      </div>
    </Dialog>
  );
}

interface ConfirmDisconnectDialogProps {
  readonly connection: CalendarConnection;
  readonly sync: CalendarSyncState;
  readonly onClose: () => void;
}

function ConfirmDisconnectDialog({
  connection,
  sync,
  onClose,
}: ConfirmDisconnectDialogProps): ReactElement {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  async function confirm(): Promise<void> {
    setInFlight(true);
    setRefusal(null);
    try {
      const outcome = await sync.disconnect(connection.id);
      if (outcome.refusal !== null) {
        setRefusal(outcome.refusal);
        return;
      }
      onClose();
    } finally {
      setInFlight(false);
    }
  }

  return (
    <Dialog
      open
      title={`Disconnect ${connection.accountEmail}?`}
      onClose={() => {
        if (!inFlight) {
          onClose();
        }
      }}
      closeLabel="Keep the account connected"
      actions={
        <>
          <Button variant="secondary" disabled={inFlight} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={inFlight}
            onClick={() => {
              void confirm();
            }}
          >
            {inFlight ? 'Disconnecting the account' : 'Disconnect account'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Text variant="bodySmall">
          Its linked calendars stop syncing. Their notes stay in the workspace and stay protected
          until you unlink each calendar.
        </Text>
        {refusal === null ? null : (
          <Text variant="note" role="alert">
            {refusal}
          </Text>
        )}
      </div>
    </Dialog>
  );
}

interface SyncLogDialogProps {
  readonly link: CalendarLink;
  readonly sync: CalendarSyncState;
  readonly onClose: () => void;
}

/** The newest things a link's sync did, so a missing or doubled event can be explained. */
function SyncLogDialog({ link, sync, onClose }: SyncLogDialogProps): ReactElement {
  const { logOf } = sync;
  const [entries, setEntries] = useState<readonly CalendarSyncLogEntry[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void logOf(link.id).then((read) => {
      if (current) {
        setEntries(read.entries);
        setRefusal(read.refusal);
      }
    });
    return () => {
      current = false;
    };
  }, [logOf, link.id]);

  const columns = [
    {
      key: 'at',
      header: 'When',
      rowHeader: true,
      cell: (entry: CalendarSyncLogEntry) => formatMoment(entry.at),
    },
    {
      key: 'direction',
      header: 'Direction',
      cell: (entry: CalendarSyncLogEntry) =>
        entry.direction === 'pull' ? 'From calendar' : 'To calendar',
    },
    { key: 'action', header: 'What', cell: (entry: CalendarSyncLogEntry) => entry.action },
    { key: 'detail', header: 'Detail', cell: (entry: CalendarSyncLogEntry) => entry.detail },
  ] as const;

  return (
    <Dialog
      open
      title={`Sync log of ${link.name}`}
      onClose={onClose}
      closeLabel="Close the log"
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {refusal === null ? (
        <Table
          caption="The newest fifty sync events, newest first."
          columns={columns}
          rows={entries ?? []}
          rowKey={(entry) => entry.id}
          loading={entries === null}
          loadingMessage="Reading the sync log."
          emptyMessage="Nothing has been synced yet."
        />
      ) : (
        <Text variant="note" role="alert">
          {refusal}
        </Text>
      )}
    </Dialog>
  );
}
