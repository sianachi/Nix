/**
 * The calendar sync resource: the only place its URLs appear.
 *
 * Everything hangs under `/me`: a connection is the caller's own account at a provider, and a
 * link is theirs too even when its container sits in a shared workspace. Connecting and
 * disconnecting need an interactive session; the API refuses a token-authenticated caller there.
 */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import {
  authorizeCalendarSchema,
  calendarConnectionsSchema,
  calendarLinkSchema,
  calendarLinksSchema,
  calendarSyncLogPageSchema,
  externalCalendarsSchema,
  syncCalendarLinkSchema,
  workspaceCalendarLinksSchema,
  type WorkspaceCalendarLinks,
  type AuthorizeCalendar,
  type CalendarConnections,
  type CalendarLink,
  type CalendarLinks,
  type CalendarSyncLogPage,
  type ExternalCalendars,
  type SyncCalendarLink,
} from '../schemas/calendar-sync.js';
import { noContentSchema } from '../schemas/index.js';

const connectionsKey: readonly string[] = ['me', 'calendar', 'connections'];
const linksKey: readonly string[] = ['me', 'calendar', 'links'];

const connectionPath = (connectionId: string): string =>
  `/api/v1/me/calendar/connections/${encodeURIComponent(connectionId)}`;
const linkPath = (linkId: string): string =>
  `/api/v1/me/calendar/links/${encodeURIComponent(linkId)}`;

/** The caller's connected accounts, and which providers this deployment can connect. */
export const listConnections = (): QueryEndpoint<CalendarConnections> =>
  defineQuery<CalendarConnections>({
    operation: 'calendarSync.listConnections',
    path: '/api/v1/me/calendar/connections',
    schema: calendarConnectionsSchema,
    cacheKey: connectionsKey,
  });

/**
 * Starts connecting an account. The answer is a URL at the provider; the browser goes there, and
 * the provider sends it back to `returnTo` with `calendar_status` set to `connected`, `cancelled`
 * or `failed`. Fails with `calendar.provider_unavailable` when the deployment has no client for it.
 */
export const authorize = (
  provider: string,
  returnTo: string | null,
): CommandEndpoint<AuthorizeCalendar> =>
  defineCommand<AuthorizeCalendar>({
    operation: 'calendarSync.authorize',
    method: 'POST',
    path: `/api/v1/me/calendar/connections/${encodeURIComponent(provider)}/authorize`,
    schema: authorizeCalendarSchema,
    body: { returnTo } satisfies components['schemas']['AuthorizeCalendarRequest'],
  });

/** Disconnects an account. Its links stop syncing; their items stay where they are. */
export const deleteConnection = (connectionId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'calendarSync.deleteConnection',
    method: 'DELETE',
    path: connectionPath(connectionId),
    schema: noContentSchema,
    invalidates: [connectionsKey, linksKey],
  });

/** The calendars a connected account holds. Read live from the provider, so never cached. */
export const listExternalCalendars = (connectionId: string): QueryEndpoint<ExternalCalendars> =>
  defineQuery<ExternalCalendars>({
    operation: 'calendarSync.listExternalCalendars',
    path: `${connectionPath(connectionId)}/calendars`,
    schema: externalCalendarsSchema,
  });

/** The caller's links, across every workspace. */
export const listLinks = (): QueryEndpoint<CalendarLinks> =>
  defineQuery<CalendarLinks>({
    operation: 'calendarSync.listLinks',
    path: '/api/v1/me/calendar/links',
    schema: calendarLinksSchema,
    cacheKey: linksKey,
  });

export interface CreateCalendarLinkInput {
  readonly connectionId: string;
  readonly externalCalendarId: string;
  readonly workspaceId: string;
  /** The title of the container to create for the calendar, at the workspace root. */
  readonly title: string;
  /** `two_way` or `import_only`. */
  readonly direction: string;
}

/**
 * Links an external calendar to a new container. Fails with `calendar.link_exists` when the
 * calendar is already linked, and with `calendar.invalid` when a read-only calendar is asked to
 * sync both ways.
 */
export const createLink = (input: CreateCalendarLinkInput): CommandEndpoint<CalendarLink> =>
  defineCommand<CalendarLink>({
    operation: 'calendarSync.createLink',
    method: 'POST',
    path: '/api/v1/me/calendar/links',
    schema: calendarLinkSchema,
    body: {
      connectionId: input.connectionId,
      externalCalendarId: input.externalCalendarId,
      workspaceId: input.workspaceId,
      container: { itemId: null, create: { parentId: null, title: input.title } },
      direction: input.direction,
      windowPastDays: null,
      windowFutureDays: null,
    } satisfies components['schemas']['CreateCalendarLinkRequest'],
    invalidates: [linksKey, ['workspace-tree', input.workspaceId]],
  });

export interface UpdateCalendarLinkInput {
  /** The revision the caller read; a stale one fails with `calendar.conflict`. */
  readonly revision: number | string;
  readonly direction?: string;
  /** `active` or `paused`. */
  readonly status?: string;
}

/** Changes a link's direction or pauses and resumes it. */
export const updateLink = (
  linkId: string,
  input: UpdateCalendarLinkInput,
): CommandEndpoint<CalendarLink> =>
  defineCommand<CalendarLink>({
    operation: 'calendarSync.updateLink',
    method: 'PATCH',
    path: linkPath(linkId),
    schema: calendarLinkSchema,
    body: {
      revision: input.revision,
      name: null,
      direction: input.direction ?? null,
      status: input.status ?? null,
      windowPastDays: null,
      windowFutureDays: null,
    } satisfies components['schemas']['UpdateCalendarLinkRequest'],
    invalidates: [linksKey],
  });

/**
 * Unlinks a calendar. `keep` leaves the container and its events as ordinary items; `trash` moves
 * the container to the trash. Nothing is removed from the external calendar either way.
 */
export const deleteLink = (linkId: string, items: 'keep' | 'trash'): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'calendarSync.deleteLink',
    method: 'DELETE',
    path: `${linkPath(linkId)}?items=${items}`,
    schema: noContentSchema,
    invalidates: [linksKey],
  });

/** Asks for a sync round now. Coalesces onto one already queued or running. */
export const syncLink = (linkId: string): CommandEndpoint<SyncCalendarLink> =>
  defineCommand<SyncCalendarLink>({
    operation: 'calendarSync.syncLink',
    method: 'POST',
    path: `${linkPath(linkId)}/sync`,
    schema: syncCalendarLinkSchema,
    body: { full: false } satisfies components['schemas']['SyncCalendarLinkRequest'],
    invalidates: [linksKey],
  });

/** The newest entries of a link's sync log. Never cached: it is read to see what just happened. */
export const listLog = (linkId: string): QueryEndpoint<CalendarSyncLogPage> =>
  defineQuery<CalendarSyncLogPage>({
    operation: 'calendarSync.listLog',
    path: `${linkPath(linkId)}/log`,
    schema: calendarSyncLogPageSchema,
    query: { limit: 50 },
  });

const workspaceLinksPath = (workspaceId: string): string =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/calendar-links`;

/**
 * Every container in a workspace that has a calendar linked into it, whoever linked it. For the
 * workspace's owner and the tenant's administrators; anybody else is answered
 * `calendar.link_not_found`. Never cached: it is read to decide what to unlink.
 */
export const listWorkspaceLinks = (workspaceId: string): QueryEndpoint<WorkspaceCalendarLinks> =>
  defineQuery<WorkspaceCalendarLinks>({
    operation: 'calendarSync.listWorkspaceLinks',
    path: workspaceLinksPath(workspaceId),
    schema: workspaceCalendarLinksSchema,
  });

/**
 * Unlinks the calendar on a container on a workspace administrator's authority, whoever linked
 * it. The items are kept or trashed exactly as an owner's own unlink does.
 */
export const unlinkWorkspaceLink = (
  workspaceId: string,
  containerItemId: string,
  items: 'keep' | 'trash',
): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'calendarSync.unlinkWorkspaceLink',
    method: 'DELETE',
    path: `${workspaceLinksPath(workspaceId)}/${encodeURIComponent(containerItemId)}?items=${items}`,
    schema: noContentSchema,
    invalidates: [linksKey, ['workspace-tree', workspaceId]],
  });
