import { describe, expect, it } from 'vitest';

import { createAuthorizer } from './authorize.ts';

/**
 * How Core's answer to "may this caller open this item" is read.
 *
 * Only one refusal is told apart: a body locked to this session. Everything else Core refuses is
 * the same non-answer, so "does not exist" and "not yours" stay indistinguishable here too.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

function answering(status: number, body: unknown) {
  return createAuthorizer({
    coreBaseUrl: 'http://core.test',
    internalSecret: 'secret',
    fetch: () => Promise.resolve(Response.json(body, { status })),
  });
}

describe('the Core authorizer', () => {
  it('reads a locked body as locked', async () => {
    const authorizer = answering(403, { code: 'internal.body_locked' });

    expect(await authorizer.authorize('token', ITEM)).toBe('locked');
  });

  it('reads any other refusal as the uniform non-answer', async () => {
    expect(
      await answering(404, { code: 'internal.not_found' }).authorize('token', ITEM),
    ).toBeNull();
    expect(await answering(403, { code: 'something.else' }).authorize('token', ITEM)).toBeNull();
    expect(await answering(403, 'not json at all').authorize('token', ITEM)).toBeNull();
  });
});
