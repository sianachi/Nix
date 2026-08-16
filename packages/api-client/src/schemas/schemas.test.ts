import { describe, expect, it } from 'vitest';
import {
  accessTokenSchema,
  createdAccessTokenSchema,
  cursorPageSchema,
  itemSchema,
  noContentSchema,
  problemDetailsSchema,
  tokenExchangeResponseSchema,
  workspaceGraphSchema,
} from './index.js';

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
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: { title: 'Kickoff' },
    createdAt: '2026-07-26T09:30:00.000Z',
    updatedAt: '2026-07-26T09:30:00.000Z',
  };

  it('refuses an item that does not say whether it has children', () => {
    // Optional, it would parse as undefined and the tree would read that as "no children" - so
    // every container would lose its expand control on the first build that forgot to send it.
    const { hasChildren, ...withoutIt } = valid;

    expect(hasChildren).toBe(false);
    expect(itemSchema.safeParse(withoutIt).success).toBe(false);
  });

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

describe('the timestamps an item carries', () => {
  /**
   * The spellings of UTC the server actually uses.
   *
   * This is the bug the hand-written fixture above hid for as long as it existed: it was written
   * with a `Z`, and Core does not send one. `DateTimeOffset` reaches the wire as `+00:00`, so
   * every single item response failed this check in production while the suite stayed green - the
   * contract check was, in effect, switched off for items and logging about it once per response.
   */
  const SERVER_SPELLINGS = [
    // What Core actually sends: a DateTimeOffset, offset spelled out, sub-second precision.
    '2026-07-26T21:59:30.648333+00:00',
    // The same instant with a non-zero offset, which a differently configured deployment sends.
    '2026-07-26T21:59:30.648333+01:00',
    // And the Zulu spelling, which has to keep working.
    '2026-07-26T09:30:00.000Z',
  ];

  it.each(SERVER_SPELLINGS)('accepts %s', (stamp) => {
    const parsed = itemSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      parentId: null,
      type: 'note',
      title: 'Kickoff',
      hasChildren: false,
      seq: 1000,
      lifecycleState: 'active',
      properties: { title: 'Kickoff' },
      createdAt: stamp,
      updatedAt: stamp,
    });

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('still refuses something that is not a timestamp at all', () => {
    // Loosening which spelling is accepted must not loosen whether it has to be one.
    const parsed = itemSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      parentId: null,
      type: 'note',
      title: 'Kickoff',
      hasChildren: false,
      seq: 1000,
      lifecycleState: 'active',
      properties: {},
      createdAt: 'last Tuesday',
      updatedAt: 'last Tuesday',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('the workspace graph schema', () => {
  const workspaceId = '00000000-0000-4000-8000-0000000000a0';
  const first = '00000000-0000-4000-8000-0000000000a1';
  const second = '00000000-0000-4000-8000-0000000000a2';

  it('accepts a graph whose nodes carry a parent, a kind and a name', () => {
    const parsed = workspaceGraphSchema.safeParse({
      workspaceId,
      nodes: [
        { id: first, parentId: null, type: 'note', title: 'Programme' },
        { id: second, parentId: first, type: 'canvas', title: 'Ledger review' },
      ],
      links: [{ sourceId: second, targetId: first }],
      nodeLimit: 2000,
      linkLimit: 4000,
      nodesTruncated: false,
      linksTruncated: false,
    });

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('accepts a node that has never been named rather than inventing one', () => {
    const parsed = workspaceGraphSchema.safeParse({
      workspaceId,
      nodes: [{ id: first, parentId: null, type: 'note', title: null }],
      links: [],
      nodeLimit: 2000,
      linkLimit: 4000,
      nodesTruncated: false,
      linksTruncated: false,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.nodes[0]?.title).toBeNull();
  });

  it('accepts a kind this build has never heard of', () => {
    // Item kinds are added as a feature, not as a migration. A closed set here would break every
    // client the day one landed.
    const parsed = workspaceGraphSchema.safeParse({
      workspaceId,
      nodes: [{ id: first, parentId: null, type: 'hologram', title: 'New' }],
      links: [],
      nodeLimit: 2000,
      linkLimit: 4000,
      nodesTruncated: false,
      linksTruncated: false,
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a graph that does not say whether it was truncated', () => {
    // A truncated graph looks like a graph. Without the flags a view cannot be honest about it, so
    // a response missing them is not a response this client will hand on.
    const parsed = workspaceGraphSchema.safeParse({
      workspaceId,
      nodes: [],
      links: [],
      nodeLimit: 2000,
      linkLimit: 4000,
    });

    expect(parsed.success).toBe(false);
  });
});

describe('the access token schemas', () => {
  const row = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'ci runner',
    scopes: ['read'],
    createdAt: '2026-08-16T09:30:00.000Z',
    expiresAt: '2026-09-15T09:30:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
  };

  it('accepts a row whose revocation and last use have not happened yet', () => {
    expect(accessTokenSchema.safeParse(row).success).toBe(true);
  });

  it('refuses a row that does not say when it expires', () => {
    // Expiry is chosen at creation and the list renders it; a token without one is not a shape
    // this product mints, so it is not a shape this client will hand on.
    const { expiresAt, ...withoutIt } = row;
    void expiresAt;
    expect(accessTokenSchema.safeParse(withoutIt).success).toBe(false);
  });

  it('carries the secret only in the created shape', () => {
    const created = createdAccessTokenSchema.safeParse({ token: 'nixpat_x', details: row });
    expect(created.success).toBe(true);
    expect(accessTokenSchema.safeParse({ ...row, token: 'nixpat_x' }).success).toBe(true);
    // The list shape has no token member to leak: parsing strips nothing, but the type never
    // declares one, so a component cannot reach for it.
  });

  it('parses an exchange answer with its lifetime', () => {
    const parsed = tokenExchangeResponseSchema.safeParse({
      accessToken: 'a.b.c',
      tokenType: 'Bearer',
      expiresInSeconds: 600,
    });
    expect(parsed.success).toBe(true);
  });
});
