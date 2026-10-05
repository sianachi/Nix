/**
 * The workspace calendar resource: the only place the calendar URL appears.
 *
 * One read, one descriptor. There is deliberately no property option — which property carries an
 * item's date is decided by the container that holds it, and a caller who could name the property
 * could ask this endpoint to project any field of every item in the workspace, which is a much
 * larger disclosure than a calendar.
 *
 * The window is required rather than defaulted. A server guessing "this month" would be answering a
 * question the caller did not ask, and a client that forgot the parameter would get a plausible
 * answer instead of an error.
 */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { workspaceCalendarSchema, type WorkspaceCalendar } from '../schemas/index.js';

/**
 * Cache key for one window of one workspace's calendar.
 *
 * The window is part of the key, because two windows are two answers rather than two views of one.
 * Keying on the workspace alone would serve March's entries for an April request.
 */
const workspaceCalendarKey = (workspaceId: string, from: string, to: string): readonly string[] => [
  'workspaces',
  workspaceId,
  'calendar',
  from,
  to,
];

/**
 * Every calendar in one workspace, collated into one window of dated entries.
 *
 * Items the caller may not read are absent from the entries and from the counts — the filter is
 * applied while the query runs, not to its results. A workspace the caller may not see answers
 * `workspaces.not_found`, the same code `GET /api/v1/workspaces/{id}` uses. A window that is not
 * two ordered `yyyy-MM-dd` dates answers `calendar.invalid_window` rather than an empty calendar,
 * so a typo in a date cannot read as a quiet month.
 *
 * @param workspaceId The workspace to read.
 * @param from The first day to include, `yyyy-MM-dd`, inclusive.
 * @param to The last day to include, `yyyy-MM-dd`, inclusive.
 */
export const workspaceCalendar = (
  workspaceId: string,
  from: string,
  to: string,
): QueryEndpoint<WorkspaceCalendar> =>
  defineQuery<WorkspaceCalendar>({
    operation: 'workspaceCalendar.get',
    path: `/api/v1/workspaces/${workspaceId}/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    schema: workspaceCalendarSchema,
    cacheKey: workspaceCalendarKey(workspaceId, from, to),
  });
