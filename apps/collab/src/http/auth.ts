import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { problem } from './replies.ts';

function bearer(header: string | undefined): string | null {
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
