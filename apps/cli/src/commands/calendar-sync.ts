/**
 * `nixctl calsync`: the calendars linked into Nix from Google and Outlook (ADR-0052).
 *
 * Connecting an account is a browser consent flow and is done in the web app's settings; Core
 * refuses it to a token. Everything after that is here: listing the connected accounts and their
 * calendars, linking one into a workspace, changing or pausing a link, asking for a sync, reading
 * the sync log, and unlinking.
 *
 * Unlinking never touches the external calendar. `--items keep` leaves the container and its
 * events as ordinary items; `--items trash` moves the container to the trash.
 */

import {
  calendarSync,
  type CalendarConnection,
  type CalendarLink,
  type CalendarSyncLogEntry,
  type ExternalCalendar,
  type WorkspaceCalendarLink,
} from '@nix/api-client';
import { parseUuid, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

const DIRECTIONS = ['two_way', 'import_only'] as const;
const STATUSES = ['active', 'paused'] as const;
const DISPOSITIONS = ['keep', 'trash'] as const;

function parseOneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag} must be one of ${allowed.join(', ')} - got '${value}'.`);
  }
  return value as T;
}

export async function executeListConnections(
  session: Session,
): Promise<readonly CalendarConnection[]> {
  return (await session.client.query(calendarSync.listConnections(), { forceRefresh: true }))
    .connections;
}

export async function executeListCalendars(
  session: Session,
  connectionId: string,
): Promise<readonly ExternalCalendar[]> {
  return (
    await session.client.query(calendarSync.listExternalCalendars(connectionId), {
      forceRefresh: true,
    })
  ).calendars;
}

export async function executeListLinks(session: Session): Promise<readonly CalendarLink[]> {
  return (await session.client.query(calendarSync.listLinks(), { forceRefresh: true })).links;
}

export interface CreateLinkOptions {
  readonly workspace: string;
  readonly title: string;
  readonly direction?: string;
}

export async function executeCreateLink(
  session: Session,
  connectionId: string,
  externalCalendarId: string,
  options: CreateLinkOptions,
): Promise<CalendarLink> {
  return session.client.execute(
    calendarSync.createLink({
      connectionId,
      externalCalendarId,
      workspaceId: options.workspace,
      title: options.title,
      direction: parseOneOf(options.direction ?? 'two_way', DIRECTIONS, '--direction'),
    }),
  );
}

export interface UpdateLinkOptions {
  readonly direction?: string;
  readonly status?: string;
}

/** Changes a link at the revision it currently stands at. */
export async function executeUpdateLink(
  session: Session,
  linkId: string,
  options: UpdateLinkOptions,
): Promise<CalendarLink> {
  const link = (await executeListLinks(session)).find((candidate) => candidate.id === linkId);
  if (link === undefined) {
    throw new Error(`No calendar link ${linkId} is visible.`);
  }
  return session.client.execute(
    calendarSync.updateLink(linkId, {
      revision: link.revision,
      ...(options.direction === undefined
        ? {}
        : { direction: parseOneOf(options.direction, DIRECTIONS, '--direction') }),
      ...(options.status === undefined
        ? {}
        : { status: parseOneOf(options.status, STATUSES, '--status') }),
    }),
  );
}

export async function executeUnlink(
  session: Session,
  linkId: string,
  items: string,
): Promise<{ readonly id: string; readonly unlinked: true; readonly items: string }> {
  const disposition = parseOneOf(items, DISPOSITIONS, '--items');
  await session.client.execute(calendarSync.deleteLink(linkId, disposition));
  return { id: linkId, unlinked: true, items: disposition };
}

/** Every linked container in a workspace, whoever linked it. Workspace managers only. */
export async function executeListWorkspaceLinks(
  session: Session,
  workspaceId: string,
): Promise<readonly WorkspaceCalendarLink[]> {
  return (
    await session.client.query(calendarSync.listWorkspaceLinks(workspaceId), {
      forceRefresh: true,
    })
  ).links;
}

/** Unlinks a calendar another member linked, on the authority of managing the workspace. */
export async function executeUnlinkWorkspaceLink(
  session: Session,
  workspaceId: string,
  containerItemId: string,
  items: string,
): Promise<{ readonly containerItemId: string; readonly unlinked: true; readonly items: string }> {
  const disposition = parseOneOf(items, DISPOSITIONS, '--items');
  await session.client.execute(
    calendarSync.unlinkWorkspaceLink(workspaceId, containerItemId, disposition),
  );
  return { containerItemId, unlinked: true, items: disposition };
}

export async function executeSyncLink(
  session: Session,
  linkId: string,
): Promise<{ readonly id: string; readonly jobId: string }> {
  const { jobId } = await session.client.execute(calendarSync.syncLink(linkId));
  return { id: linkId, jobId };
}

export async function executeLinkLog(
  session: Session,
  linkId: string,
): Promise<readonly CalendarSyncLogEntry[]> {
  return (await session.client.query(calendarSync.listLog(linkId), { forceRefresh: true })).entries;
}

/** Runs one of the above for a profile and prints what it answered. */
export async function runCalendarSync<T>(
  profileName: string | undefined,
  action: (session: Session) => Promise<T>,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await action(session), output);
}

export { parseUuid as parseCalendarSyncId };
