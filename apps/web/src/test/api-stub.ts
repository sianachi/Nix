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
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly seq: number;
  readonly lifecycleState: string;
}

export interface StubOptions {
  readonly isTenantAdministrator?: boolean;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly items?: readonly StubItem[];
  /** Makes the profile request fail, for tests about what the menu does then. */
  readonly profileFails?: boolean;
  /** Makes the tree request fail. */
  readonly treeFails?: boolean;
}

export function item(overrides: Partial<StubItem> & { id: string; title: string }): StubItem {
  return {
    type: 'note',
    parentId: null,
    seq: 1000,
    lifecycleState: 'active',
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
  } = options;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

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

      if (url.includes('/items')) {
        if (treeFails) {
          return Promise.resolve(json({ detail: 'The tree could not be loaded.' }, 500));
        }

        // The tree fetches one parent at a time, so a request naming a parent gets that parent's
        // children and a request naming none gets the roots.
        const parent = /parentId=([^&]+)/.exec(url)?.[1] ?? null;
        return Promise.resolve(
          json({ items: items.filter((candidate) => candidate.parentId === parent) }),
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
