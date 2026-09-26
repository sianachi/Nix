import type { StructureProperty } from '../types.js';

/**
 * Ports `PropertyValidator.Check` (`backend/src/Nix.Api/Domain/Properties/PropertyValidator.cs:215-536`)
 * to the client so a pet's proposed value is refused before any write, not after. `null` is
 * accepted for every type without inspecting it further, matching `PropertyValidator.IsAbsent`:
 * the server never runs `Check` against an absent value, and an explicit `null` is a client
 * clearing a field, not a value of the wrong shape. Two differences from the server beyond that:
 * `assignee` is always refused here rather than checked for shape, because a pet has no way to
 * confirm a member id names a real workspace member (architecture 1.3's non-goal); and
 * `multi_select` also refuses a repeated option, which the server does not check - a pet
 * composing a list of options by hand is exactly the client that would send one twice.
 *
 * Returns the reason the value cannot be stored, or `null` when it can.
 */
export function validateValue(definition: StructureProperty, value: unknown): string | null {
  if (value === null) {
    return null;
  }

  switch (definition.type) {
    case 'text':
      return checkText(definition, value);
    case 'number':
      return checkNumber(definition, value);
    case 'checkbox':
    case 'completion':
      return checkBoolean(definition, value);
    case 'date':
    case 'due_date':
    case 'start_date':
      return checkDate(definition, value);
    case 'timestamp':
      return checkTimestamp(definition, value);
    case 'url':
      return checkUrl(definition, value);
    case 'image':
      return checkImage(definition, value);
    case 'select':
      return checkSelect(definition, value);
    case 'multi_select':
      return checkMultiSelect(definition, value);
    case 'priority':
      return checkPriority(definition, value);
    case 'estimate':
      return checkEstimate(definition, value);
    case 'assignee':
      return `${definition.label} is a person's assignment; a pet request cannot set who something belongs to.`;
    case 'formula':
    case 'rollup':
      return `${definition.label} is computed and cannot be set.`;
    default:
      return `${definition.label} is a type this request does not know how to set a value for.`;
  }
}

function checkText(definition: StructureProperty, value: unknown): string | null {
  return typeof value === 'string' ? null : `${definition.label} must be text.`;
}

function checkNumber(definition: StructureProperty, value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? null
    : `${definition.label} must be a number.`;
}

function checkBoolean(definition: StructureProperty, value: unknown): string | null {
  return typeof value === 'boolean' ? null : `${definition.label} must be true or false.`;
}

const CALENDAR_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether text is a real calendar day, as `DateOnly.TryParseExact(text, "yyyy-MM-dd", ...)`
 * checks it - `new Date` alone is not enough, because it rolls an out-of-range day or month over
 * into the next one (`2026-02-30` becomes 2 March) instead of refusing it. Exported so
 * `view-rules.ts`'s day-filter grammar shares this one calendar-day check with `checkDate` and
 * `checkTimestamp` rather than keeping its own, looser, shape-only copy.
 */
export function isRealCalendarDay(text: string): boolean {
  const parts = text.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function checkDate(definition: StructureProperty, value: unknown): string | null {
  const shape = `${definition.label} must be a date, as yyyy-MM-dd.`;
  if (typeof value !== 'string' || !CALENDAR_DAY_PATTERN.test(value)) {
    return shape;
  }
  return isRealCalendarDay(value) ? null : shape;
}

/**
 * A timestamp is a local time, its offset and its zone, as RFC 9557 -
 * `2026-03-17T09:00:00+00:00[Europe/London]` - checked the same way
 * `PropertyValidator.CheckTimestamp` checks it against NodaTime's zone database: the zone must be
 * one this build knows, and the offset must be what that zone was actually using at that moment.
 * Node's own `Intl` carries the IANA time zone database (full ICU, bundled since Node 13), so the
 * same check is possible here without a second zone-data dependency; nothing here is a documented
 * gap against the server rule.
 */
const TIMESTAMP_SHAPE_SUFFIX =
  'must be a time with its zone, as 2026-03-17T09:00:00+00:00[Europe/London]';
const TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([+-]\d{2}:\d{2})$/;

function checkTimestamp(definition: StructureProperty, value: unknown): string | null {
  const shape = `${definition.label} ${TIMESTAMP_SHAPE_SUFFIX}.`;
  if (typeof value !== 'string') {
    return shape;
  }

  const open = value.indexOf('[');
  if (open < 0 || !value.endsWith(']')) {
    return shape;
  }

  const zoneId = value.slice(open + 1, -1);
  const instantText = value.slice(0, open);
  const match = TIMESTAMP_PATTERN.exec(instantText);
  if (match === null) {
    return shape;
  }

  // `new Date` rolls an impossible day (2026-02-30) or an out-of-range hour (24:00:00) into the
  // next one instead of refusing it, which `OffsetDateTimePattern.Rfc3339.Parse` does not - so
  // the calendar day and the clock fields are checked by hand before the instant is trusted.
  const datePart = match[1];
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (
    datePart === undefined ||
    !isRealCalendarDay(datePart) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return shape;
  }

  if (!isKnownTimeZone(zoneId)) {
    return `${definition.label} names the time zone '${zoneId}', which is not one this build knows.`;
  }

  const instant = new Date(instantText);
  if (Number.isNaN(instant.getTime())) {
    return shape;
  }

  const writtenOffset = parseOffsetMinutes(match[5] ?? '');
  const actualOffset = zoneOffsetMinutes(zoneId, instant);
  if (writtenOffset === null || actualOffset === null || writtenOffset !== actualOffset) {
    return `${definition.label} has an offset that '${zoneId}' was not using at that moment.`;
  }

  return null;
}

const knownTimeZones = new Map<string, boolean>();

/**
 * Whether `zoneId` is an IANA zone `Intl` recognises. Two checks `Intl` alone does not make:
 * `Intl.DateTimeFormat` accepts a zone id in any case (`europe/london`) where NodaTime's tzdb
 * lookup is case-sensitive, so the resolved zone's own canonical spelling must match what was
 * written exactly; and `Intl` also accepts a bare offset like `+01:00` as if it were a zone name,
 * which is a leftover from the shape check already refusing it as a zone with no name - NodaTime's
 * `GetZoneOrNull` has no such fallback.
 */
function isKnownTimeZone(zoneId: string): boolean {
  const cached = knownTimeZones.get(zoneId);
  if (cached !== undefined) {
    return cached;
  }

  let known = false;
  if (!/^[+-]/.test(zoneId)) {
    try {
      const probe = new Intl.DateTimeFormat('en-US', { timeZone: zoneId });
      known = probe.resolvedOptions().timeZone === zoneId;
    } catch {
      known = false;
    }
  }
  knownTimeZones.set(zoneId, known);
  return known;
}

function parseOffsetMinutes(text: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(text);
  if (match === null) {
    return null;
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function zoneOffsetMinutes(zoneId: string, instant: Date): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zoneId,
      timeZoneName: 'longOffset',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const part = formatter
      .formatToParts(instant)
      .find((entry) => entry.type === 'timeZoneName')?.value;
    if (part === undefined) {
      return null;
    }
    if (part === 'GMT') {
      return 0;
    }
    const match = /^GMT([+-]\d{2}:\d{2})$/.exec(part);
    const offsetText = match?.[1];
    return offsetText === undefined ? null : parseOffsetMinutes(offsetText);
  } catch {
    return null;
  }
}

/**
 * Whether text is an absolute http or https address, mirroring
 * `Uri.TryCreate(text, UriKind.Absolute, ...)`'s scheme check. A regex rather than the `URL`
 * constructor: this package has no platform (it is built without DOM or Node's lib types, so it
 * can be imported from the browser, `nixctl` and the worker's catalog generator alike), and a
 * scheme-and-non-empty-host check is all either check ever asks of the text.
 */
const ABSOLUTE_HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

function isHttpUrl(text: string): boolean {
  return ABSOLUTE_HTTP_URL_PATTERN.test(text);
}

function checkUrl(definition: StructureProperty, value: unknown): string | null {
  return typeof value === 'string' && isHttpUrl(value)
    ? null
    : `${definition.label} must be an http or https address.`;
}

const FILE_IMAGE_PREFIX = 'nix-file:';
// Case-insensitive: `Guid.TryParseExact(text, "D", ...)` accepts upper-case hex digits too.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isFileImageReference(text: string): boolean {
  return (
    text.startsWith(FILE_IMAGE_PREFIX) && UUID_PATTERN.test(text.slice(FILE_IMAGE_PREFIX.length))
  );
}

function checkImage(definition: StructureProperty, value: unknown): string | null {
  const shape = `${definition.label} must be a link to an image, over http or https.`;
  if (typeof value !== 'string') {
    return shape;
  }
  return isFileImageReference(value) || isHttpUrl(value) ? null : shape;
}

function checkSelect(definition: StructureProperty, value: unknown): string | null {
  if (typeof value !== 'string') {
    return `${definition.label} must be one of its options.`;
  }
  return definition.options.includes(value)
    ? null
    : `${definition.label} does not offer '${value}'.`;
}

function checkMultiSelect(definition: StructureProperty, value: unknown): string | null {
  if (!Array.isArray(value)) {
    return `${definition.label} must be a list of its options.`;
  }

  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      return `${definition.label} takes text values; '${JSON.stringify(entry)}' is not one.`;
    }
    if (!definition.options.includes(entry)) {
      return `${definition.label} does not offer '${entry}'.`;
    }
    if (seen.has(entry)) {
      return `${definition.label} lists '${entry}' more than once.`;
    }
    seen.add(entry);
  }

  return null;
}

function checkPriority(definition: StructureProperty, value: unknown): string | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
    ? null
    : `${definition.label} must be a whole number from 1 (most urgent) to 4.`;
}

function checkEstimate(definition: StructureProperty, value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? null
    : `${definition.label} must be a number of zero or more.`;
}
