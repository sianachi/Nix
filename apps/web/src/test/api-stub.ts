import { vi } from 'vitest';

/**
 * A stand-in for Core, for tests about what the application renders.
 *
 * The shell asks Core two things on every mount - who the caller is, and what is in the workspace -
 * so without this every suite would be a suite about failed requests. Stubbing at `fetch` rather
 * than at the hook keeps the hooks under test: the request they build, the parse they do and the
 * states they move through are all still exercised.
 *
 * Each test that cares states what it wants back. The default is the boring case: a signed-in
 * ordinary member with an empty workspace.
 */

export interface StubItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  readonly seq: number;
  readonly lifecycleState: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The id a created item is given.
 *
 * Uuid-shaped, because every route in this stub matches `[0-9a-f-]{36}` and a readable id like
 * `created-1` is not hex - a freshly created item would be unreadable by id, which is exactly the
 * path a create test walks next.
 */
function createdId(sequence: number): string {
  return `cccccccc-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

/** The workspace every stub item belongs to, matching what the app reads from its environment. */
const STUB_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/** A container's views, keyed by the item that offers them. */
export type StubViews = Readonly<Record<string, { views: readonly unknown[]; default: string }>>;

export interface StubOptions {
  readonly isTenantAdministrator?: boolean;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly items?: readonly StubItem[];
  /** Makes the profile request fail, for tests about what the menu does then. */
  readonly profileFails?: boolean;
  /** Makes the tree request fail. */
  readonly treeFails?: boolean;

  /** Makes every create fail, with this as the problem detail. */
  readonly createRefusal?: string;

  /**
   * Views per item. Anything not listed offers none, which is what an item nobody has configured
   * reports and therefore what most tests want.
   */
  readonly views?: StubViews;
}

export function item(overrides: Partial<StubItem> & { id: string; title: string }): StubItem {
  return {
    workspaceId: STUB_WORKSPACE_ID,
    type: 'note',
    parentId: null,

    // Derived server-side from whether any child row exists. A stub item is a leaf unless a test
    // says otherwise, which is what most of them are.
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',

    // The full envelope, because a container's children are parsed against the real contract on
    // the way in. A stub that sent less would make every test about views fail as a contract
    // mismatch rather than as whatever it was actually asserting.
    properties: { title: overrides.title },
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T09:00:00.000Z',
    ...overrides,
  };
}

/** Installs the stub. `vi.unstubAllGlobals` in the global teardown removes it. */
export function stubCoreApi(options: StubOptions = {}): void {
  const {
    isTenantAdministrator = false,
    displayName = 'Test Person',
    email = 'test@example.test',
    items = [],
    profileFails = false,
    treeFails = false,
    views = {},
    createRefusal,
  } = options;

  // The items the stub knows about. Mutable, because a create has to be visible to the reads that
  // follow it - a stub whose POST returns an item that the next GET has never heard of tests the
  // opposite of what a creation test means to.
  const known = [...items];

  // What has been written back. Seeded from the options so a test can start with an item already
  // configured, and updated by every PUT so the read that follows one agrees with it.
  const stored: {
    views: Record<string, { views: readonly unknown[]; default: string }>;
    schema: Record<
      string,
      { properties: readonly unknown[]; declared: readonly unknown[]; inherit: boolean }
    >;
  } = { views: { ...views }, schema: {} };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/api/v1/me')) {
        return Promise.resolve(
          profileFails
            ? json({ code: 'identity.principal_not_found' }, 404)
            : json({
                id: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
                tenantId: '11111111-1111-4111-8111-111111111111',
                displayName,
                email,
                isTenantAdministrator,
              }),
        );
      }

      // Views and schema are read per item and degrade to nothing when absent, which is the
      // ordinary case rather than an error - see useContainer.
      //
      // Writes are kept, because a stub that answered a PUT with 200 and then served the old value
      // on the next GET would make "apply a template" appear to work and change nothing - which is
      // precisely the shape of bug a test here exists to catch.
      const viewsFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/views$/.exec(url);
      if (viewsFor !== null) {
        const id = viewsFor[1] ?? '';

        if (method === 'PUT') {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            views?: readonly unknown[];
            default?: string | null;
          };

          stored.views[id] = {
            views: body.views ?? [],
            default: body.default ?? 'document',
          };
        }

        const offered = stored.views[id];
        return Promise.resolve(
          json(
            offered === undefined
              ? { views: [], unrenderable: [], default: 'document' }
              : { views: offered.views, unrenderable: [], default: offered.default },
          ),
        );
      }

      const schemaFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/schema$/.exec(url);
      if (schemaFor !== null) {
        const id = schemaFor[1] ?? '';

        if (method === 'PUT') {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            properties?: readonly unknown[];
            inherit?: boolean;
          };

          stored.schema[id] = {
            properties: body.properties ?? [],
            declared: body.properties ?? [],
            inherit: body.inherit ?? true,
          };
        }

        return Promise.resolve(
          json(stored.schema[id] ?? { properties: [], declared: [], inherit: true }),
        );
      }

      // A single item by id, which is what revealing a deep link walks up through.
      const single = /\/api\/v1\/items\/([0-9a-f-]{36})$/.exec(url);
      if (single !== null) {
        const found = known.find((candidate) => candidate.id === single[1]);
        return Promise.resolve(found === undefined ? json({}, 404) : json(found));
      }

      // Creating. Dispatched on the method, which this stub used not to look at - so a POST fell
      // through to the listing below and came back as a page envelope, and the caller built an item
      // with an undefined id. That is why no test could assert a create had worked.
      if (method === 'POST' && /\/api\/v1\/workspaces\/[0-9a-f-]{36}\/items$/.test(url)) {
        if (createRefusal !== undefined) {
          return Promise.resolve(json({ detail: createRefusal }, 422));
        }

        // `BodyInit` is a union that includes Blob and FormData, neither of which stringifies to
        // anything useful. Every caller here sends JSON text, so narrowing to it says so.
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        const body = JSON.parse(raw) as {
          title?: string;
          type?: string;
          parentId?: string | null;
          properties?: Record<string, unknown>;
        };

        const created = item({
          id: createdId(known.length),
          title: body.title ?? 'Untitled',
          type: body.type ?? 'note',
          parentId: body.parentId ?? null,
          properties: { title: body.title ?? 'Untitled', ...body.properties },
        });

        known.push(created);
        return Promise.resolve(json(created, 201));
      }

      if (url.includes('/items')) {
        if (treeFails) {
          return Promise.resolve(json({ detail: 'The tree could not be loaded.' }, 500));
        }

        // The tree fetches one parent at a time, so a request naming a parent gets that parent's
        // children and a request naming none gets the roots.
        const parent = /parentId=([^&]+)/.exec(url)?.[1] ?? null;
        return Promise.resolve(
          json({ items: known.filter((candidate) => candidate.parentId === parent) }),
        );
      }

      return Promise.resolve(json({}, 404));
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
