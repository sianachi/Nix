import { describe, expect, it } from 'vitest';
import { cursorPageSchema, itemSchema, noContentSchema, problemDetailsSchema } from './index.js';

describe('the problem details schema', () => {
  it('accepts a document from Core and keeps its stable code', () => {
    const result = problemDetailsSchema.safeParse({
      type: 'https://nix.example/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'You cannot read this item.',
      code: 'item.forbidden',
      traceId: '00-trace',
      errors: { itemId: ['Unknown item.'] },
    });

    expect(result.success).toBe(true);
    expect(result.data?.code).toBe('item.forbidden');
  });

  it('preserves the extension members RFC 9457 allows', () => {
    const result = problemDetailsSchema.parse({
      code: 'quota.exceeded',
      status: 429,
      retryAfterSeconds: 30,
    });

    expect(result.retryAfterSeconds).toBe(30);
  });

  it('rejects a document without the stable code the frontend switches on', () => {
    expect(problemDetailsSchema.safeParse({ title: 'Broken', status: 500 }).success).toBe(false);
  });
});

describe('the item schema', () => {
  const valid = {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: null,
    type: 'note',
    title: 'Kickoff',
    seq: 1000,
    lifecycleState: 'active',
    createdAt: '2026-07-26T09:30:00.000Z',
    updatedAt: '2026-07-26T09:30:00.000Z',
  };

  it('accepts a well formed item', () => {
    expect(itemSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an identifier that is not a uuid', () => {
    expect(itemSchema.safeParse({ ...valid, id: '42' }).success).toBe(false);
  });

  it('accepts a kind this build has no special rendering for', () => {
    // Deliberately the opposite of what an enum would do. Item kinds are added as a feature, so a
    // client that refused to parse an unfamiliar one would break on every backend release that
    // introduced one. Rendering it generically is the honest response.
    expect(itemSchema.safeParse({ ...valid, type: 'spreadsheet' }).success).toBe(true);
  });

  it('accepts a sibling position sent as a string, which int64 permits', () => {
    expect(itemSchema.safeParse({ ...valid, seq: '9007199254740993' }).success).toBe(true);
  });

  it('rejects an item missing the lifecycle state a view needs to be honest about', () => {
    const { lifecycleState, ...withoutState } = valid;
    expect(lifecycleState).toBe('active');
    expect(itemSchema.safeParse(withoutState).success).toBe(false);
  });

  it('rejects a timestamp that is not an instant', () => {
    expect(itemSchema.safeParse({ ...valid, updatedAt: 'yesterday' }).success).toBe(false);
  });
});

describe('the cursor page schema', () => {
  const page = cursorPageSchema(itemSchema);

  it('accepts a last page whose cursor is explicitly null', () => {
    expect(page.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('rejects a page that leaves the cursor out rather than nulling it', () => {
    expect(page.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('the no content schema', () => {
  it('accepts the empty body a 204 response carries', () => {
    expect(noContentSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects a body where the endpoint promised none', () => {
    expect(noContentSchema.safeParse({ unexpected: true }).success).toBe(false);
  });
});
