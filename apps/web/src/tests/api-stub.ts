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

  /** Makes every search fail, for tests about what the palette says then. */
  readonly searchFails?: boolean;

  /** Makes every backlinks read fail. */
  readonly backlinksFail?: boolean;

  /**
   * Makes the workspace graph read fail with `404 workspaces.not_found` - the refusal Core gives
   * for a workspace the caller may not see.
   */
  readonly graphFails?: boolean;

  /**
   * Makes the graph route answer a bodyless 404, the way a server running a build older than the
   * endpoint does. Distinct from `graphFails` on purpose: the two are the same status and mean
   * completely different things, and telling them apart is the view's job.
   */
  readonly graphRouteMissing?: boolean;

  /**
   * The reference edges the graph read reports, stated rather than derived: this stub knows
   * nothing about document contents, and the real edges are extracted from them by the
   * collaboration service. Same reasoning as `backlinks` above.
   */
  readonly graphLinks?: readonly { readonly sourceId: string; readonly targetId: string }[];

  /**
   * Makes the graph read claim it hit a ceiling, so a test can assert the view says so. The
   * payload is not actually truncated - what is under test is whether the flag reaches the reader,
   * not whether the server can count.
   */
  readonly graphTruncated?: { readonly nodes?: boolean; readonly links?: boolean };

  /**
   * The dated entries the collated calendar read reports.
   *
   * Stated rather than derived from `items`, for the reason `backlinks` and `graphLinks` are: this
   * stub knows nothing about container views or schemas, and which property carries an item's date
   * is resolved server-side from the container's stored views.
   */
  readonly calendarEntries?: readonly {
    readonly itemId: string;
    readonly title: string | null;
    readonly containerId: string;
    readonly containerTitle: string | null;
    readonly dateProperty: string;
    readonly value: string;
    readonly kind: 'date' | 'timestamp';
  }[];

  /** Containers the calendar read reports as offering a calendar it could place nothing on. */
  readonly calendarUnplaceable?: readonly {
    readonly containerId: string;
    readonly containerTitle: string | null;
    readonly reason: string;
  }[];

  /** What the caller has kept, as the shelf read reports it. */
  readonly bookmarks?: readonly {
    readonly itemId: string;
    readonly title: string | null;
    readonly type: string;
    readonly workspaceId: string;
    readonly keptAt: string;
  }[];

  /** How many kept items the shelf read says it cannot show. */
  readonly bookmarksHidden?: number;

  /** Makes the shelf read fail. */
  readonly bookmarksFail?: boolean;

  /** Makes the calendar read fail with the refusal Core gives for an invisible workspace. */
  readonly calendarFails?: boolean;

  /** Makes the calendar read claim it hit its entry ceiling. */
  readonly calendarTruncated?: boolean;

  /**
   * Which items link to which, keyed by the target.
   *
   * Stated rather than derived from document contents: this stub knows nothing about documents,
   * and the edges are extracted from them by the collaboration service in the real system.
   */
  readonly backlinks?: Readonly<Record<string, readonly string[]>>;

  /** Makes every create fail, with this as the problem detail. */
  readonly createRefusal?: string;

  /** Makes every delete fail, rather than the ordinary always-succeeds stub behavior. */
  readonly removeFails?: boolean;

  /** Makes every restore fail, rather than the ordinary always-succeeds stub behavior. */
  readonly restoreFails?: boolean;

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
/** What a test can read back about what the application wrote. */
export interface StubWrites {
  /** Every property PATCH, in the order it was sent. */
  readonly properties: readonly { itemId: string; properties: Record<string, unknown> }[];
}

export function stubCoreApi(options: StubOptions = {}): StubWrites {
  const {
    isTenantAdministrator = false,
    displayName = 'Test Person',
    email = 'test@example.test',
    items = [],
    profileFails = false,
    treeFails = false,
    searchFails = false,
    backlinksFail = false,
    backlinks = {},
    graphFails = false,
    graphRouteMissing = false,
    graphLinks = [],
    graphTruncated = {},
    calendarEntries = [],
    calendarUnplaceable = [],
    bookmarks = [],
    bookmarksHidden = 0,
    bookmarksFail = false,
    calendarFails = false,
    calendarTruncated = false,
    views = {},
    createRefusal,
    removeFails = false,
    restoreFails = false,
  } = options;

  // The items the stub knows about. Mutable, because a create has to be visible to the reads that
  // follow it - a stub whose POST returns an item that the next GET has never heard of tests the
  // opposite of what a creation test means to.
  const known = [...items];

  // The shelf the stub holds. Mutable, because keeping something has to be visible to the read that
  // follows it - a stub whose PUT is forgotten by the next GET tests the opposite of what a
  // bookmarking test means to.
  let kept = [...bookmarks];

  // Every property PATCH the application made, in order, for tests about what a write actually
  // sent rather than about what the view drew afterwards.
  const propertyWrites: { itemId: string; properties: Record<string, unknown> }[] = [];

  /** The four fields every item listing projects, as Core returns them. */
  function digest(item: StubItem): {
    id: string;
    workspaceId: string;
    type: string;
    title: string | null;
  } {
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      type: item.type,
      title: item.title.length === 0 ? null : item.title,
    };
  }

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

      // Rescheduling from the collated calendar. The stub records what was written so a test can
      // assert the *value*, which is the whole risk in a drag: the day is easy and the time is not.
      const propertyWrite = /\/api\/v1\/items\/([0-9a-f-]{36})\/properties$/.exec(url);
      if (propertyWrite !== null && method === 'PATCH') {
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        const written =
          typeof body === 'object' && body !== null && 'properties' in body
            ? (body.properties as Record<string, unknown>)
            : {};

        propertyWrites.push({ itemId: propertyWrite[1] ?? '', properties: written });
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      // Ordered before the /me route below, which would otherwise swallow it.
      if (url.includes('/api/v1/me/bookmarks')) {
        return Promise.resolve(
          bookmarksFail
            ? json({ code: 'bookmarks.unavailable' }, 500)
            : json({ items: kept, hidden: bookmarksHidden }),
        );
      }

      // Keeping and releasing. The stub holds the shelf in memory so a test can press a control and
      // then assert on what the next read says, which is the whole round trip the store makes.
      const bookmarkWrite = /\/api\/v1\/items\/([0-9a-f-]{36})\/bookmark$/.exec(url);
      if (bookmarkWrite !== null && (method === 'PUT' || method === 'DELETE')) {
        const itemId = bookmarkWrite[1] ?? '';
        if (method === 'PUT') {
          if (!kept.some((entry) => entry.itemId === itemId)) {
            const item = known.find((candidate) => candidate.id === itemId);
            kept.unshift({
              itemId,
              title: item?.title ?? 'Untitled',
              type: item?.type ?? 'note',
              workspaceId: STUB_WORKSPACE_ID,
              keptAt: '2026-03-17T09:00:00+00:00',
            });
          }
        } else {
          kept = kept.filter((entry) => entry.itemId !== itemId);
        }

        return Promise.resolve(new Response(null, { status: 204 }));
      }

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

      // Undoing a delete. Answered from the same `known` list a delete never actually removes an
      // item from - only the client's own state drops it, optimistically, the moment the request
      // is sent - so restoring just hands the item back.
      const restoreFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/restore$/.exec(url);
      if (restoreFor !== null && method === 'POST') {
        if (restoreFails) {
          return Promise.resolve(json({ detail: 'The item could not be restored.' }, 500));
        }
        const found = known.find((candidate) => candidate.id === restoreFor[1]);
        return Promise.resolve(found === undefined ? json({}, 404) : json(found));
      }

      // A single item by id, which is what revealing a deep link walks up through and what a
      // delete or a plain read both address.
      const single = /\/api\/v1\/items\/([0-9a-f-]{36})$/.exec(url);
      if (single !== null) {
        if (method === 'DELETE' && removeFails) {
          return Promise.resolve(json({ detail: 'The item could not be deleted.' }, 500));
        }
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

      // Search, reference resolution and backlinks all read the same seeded items, so a test that
      // stubs a workspace gets a working palette and a working picker without saying anything more.
      const calendarWindow =
        /\/api\/v1\/workspaces\/[0-9a-f-]{36}\/calendar\?from=([^&]+)&to=([^&]+)/.exec(url);
      if (calendarWindow !== null) {
        if (calendarFails) {
          return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        }

        return Promise.resolve(
          json({
            workspaceId: STUB_WORKSPACE_ID,
            from: decodeURIComponent(calendarWindow[1] ?? ''),
            to: decodeURIComponent(calendarWindow[2] ?? ''),
            entries: calendarEntries,
            unplaceable: calendarUnplaceable,
            entryLimit: 2000,
            entriesTruncated: calendarTruncated,
          }),
        );
      }

      if (/\/api\/v1\/workspaces\/[0-9a-f-]{36}\/graph$/.test(url)) {
        if (graphRouteMissing) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }

        if (graphFails) {
          return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        }

        return Promise.resolve(
          json({
            workspaceId: STUB_WORKSPACE_ID,
            nodes: known.map((entry) => ({
              id: entry.id,
              parentId: entry.parentId,
              type: entry.type,
              title: entry.title.length === 0 ? null : entry.title,
            })),
            links: graphLinks,
            nodeLimit: 2000,
            linkLimit: 4000,
            nodesTruncated: graphTruncated.nodes ?? false,
            linksTruncated: graphTruncated.links ?? false,
          }),
        );
      }

      // Ordered before the tree route below because a backlinks url contains "/items" too.
      const backlinksFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/backlinks/.exec(url);
      if (backlinksFor !== null) {
        const target = backlinksFor[1] ?? '';
        const sources = (backlinks[target] ?? []).flatMap((sourceId) => {
          const source = known.find((candidate) => candidate.id === sourceId);
          return source === undefined ? [] : [{ source: digest(source), occurrences: 1 }];
        });

        return Promise.resolve(
          backlinksFail
            ? json({ detail: 'The backlinks could not be read.' }, 500)
            : json({ backlinks: sources, limit: 25, truncated: false }),
        );
      }

      if (url.includes('/api/v1/search/references')) {
        const ids = (/ids=([^&]*)/.exec(url)?.[1] ?? '')
          .split(',')
          .filter((id) => id.length > 0)
          .map((id) => decodeURIComponent(id));

        return Promise.resolve(
          json({
            references: ids.map((id) => {
              // Absent from the seeded workspace stands in for every reason the server refuses to
              // distinguish: deleted, never existed, and not visible to this caller.
              const item = known.find((candidate) => candidate.id === id);
              return item === undefined
                ? { id, readable: false, item: null }
                : { id, readable: true, item: digest(item) };
            }),
          }),
        );
      }

      if (url.includes('/api/v1/search')) {
        if (searchFails) {
          return Promise.resolve(json({ detail: 'The search could not be run.' }, 500));
        }

        const needle = decodeURIComponent(/q=([^&]*)/.exec(url)?.[1] ?? '').toLowerCase();
        const results =
          needle.length === 0
            ? []
            : known
                .filter((candidate) => candidate.title.toLowerCase().includes(needle))
                .map(digest);

        return Promise.resolve(json({ query: needle, results, limit: 20, truncated: false }));
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

  return { properties: propertyWrites };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
