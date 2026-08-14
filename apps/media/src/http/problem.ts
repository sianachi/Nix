import type { FastifyReply } from 'fastify';

/**
 * Refusals, in the one shape every Nix service uses.
 *
 * RFC 9457 with a stable `code` extension, identical to Core's and the collaboration service's, so
 * a client has one error handler rather than three - and switches on the code rather than on message
 * text that copy editing would break.
 */
export function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title: 'Request refused', status, code, detail });
}

/**
 * The token from an Authorization header, or null.
 *
 * A shape check, not a validation: this service does not verify tokens - the collaboration service
 * does, through Core. Checking the shape costs nothing and saves a round trip for a request that
 * could never have succeeded.
 */
export function bearer(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
