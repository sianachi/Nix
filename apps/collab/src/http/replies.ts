import type { FastifyReply } from 'fastify';

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
