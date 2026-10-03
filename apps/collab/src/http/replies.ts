import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

export function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
): FastifyReply {
  // The same shape Core uses, so a client has one error handler rather than two: RFC 9457
  // with a stable `code` extension that clients switch on instead of message text.
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title: 'Request refused', status, code, detail });
}

export function bearer(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const token = header.slice('bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function requestToken(request: FastifyRequest, reply: FastifyReply): string | null {
  const token = bearer(request.headers.authorization);
  if (token === null) {
    problem(reply, 401, 'unauthenticated', 'A bearer token is required.');
  }
  return token;
}

export function stringHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/**
 * Whether this request came from a service holding the internal secret.
 *
 * Caddy deliberately proxies the whole `/collab/*` prefix, including these internal routes, so
 * routing is not an authorization boundary. Compare fixed-size digests to avoid both a secret
 * length branch and an unequal-buffer timing path. Callers return the same 404 for a missing
 * or incorrect secret before they perform endpoint work.
 */
export function internalCaller(request: FastifyRequest, internalSecret: string): boolean {
  const supplied = request.headers['x-nix-internal-secret'];
  const candidate = typeof supplied === 'string' ? supplied : '';
  const expectedDigest = createHash('sha256').update(internalSecret, 'utf8').digest();
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
