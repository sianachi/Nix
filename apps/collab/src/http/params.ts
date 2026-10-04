import type { FastifyRequest } from 'fastify';

/**
 * The catch-up cursor, `after`: a sequence as a bigint, because it is compared against `head_seq`
 * directly. Absent means from the start, so it defaults to 0 rather than being optional.
 */
export function parseAfterCursor(value: string | undefined): bigint | null {
  if (value === undefined) {
    return 0n;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  return BigInt(value);
}

const NON_NEGATIVE_INTEGER = /^\d+$/;

/**
 * A required `seq` from a URL path segment - the history route's `:seq`, always present as a
 * string. Null for anything that is not a non-negative integer safe as a JS number, which is
 * the unit `listRevisions`, `stateAt` and the rest of the history data layer already use it in.
 */
export function parseSeqParam(value: string): number | null {
  if (!NON_NEGATIVE_INTEGER.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The optional `before` cursor: undefined when absent, the parsed seq, or `'invalid'`. */
export function parseOptionalSeq(value: string | undefined): number | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseSeqParam(value);
  return parsed ?? 'invalid';
}

/** `seq` out of a JSON body, which may have arrived as a number or a numeric string. */
export function parseSeqBody(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    return parseSeqParam(value);
  }
  return null;
}

/** `limit`, clamped to the contract's 1..100 window. Anything unparseable is the default, 50. */
export function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 50;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return 50;
  }

  return Math.min(100, Math.max(1, parsed));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64(value: string): Uint8Array | null {
  // Checked before decoding, because `Buffer.from(..., 'base64')` silently drops characters
  // it cannot parse rather than failing. A payload with a typo in it would otherwise decode
  // to a shorter buffer, be applied as a Yjs update, and either corrupt the document or
  // produce a refusal that blames the wrong thing.
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    return null;
  }

  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function stringHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
