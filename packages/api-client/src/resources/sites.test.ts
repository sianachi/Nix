import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient, type NixClient } from '../client.js';
import { isNixApiError } from '../errors.js';
import type { SiteBuild } from '../schemas/sites.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import {
  createSite,
  deleteSite,
  getItemSite,
  getSiteBuild,
  publishSite,
  removeSiteHostname,
  updateSite,
  updateSiteHostname,
  verifySiteHostname,
  waitForBuild,
} from './sites.js';

const SITE_ID = 'b1111111-1111-4111-8111-111111111111';
const ITEM_ID = 'b2222222-2222-4222-8222-222222222222';
const BUILD_ID = 'b3333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = 'b4444444-4444-4444-8444-444444444444';

function build(status: SiteBuild['status']): Record<string, unknown> {
  return {
    id: BUILD_ID,
    siteId: SITE_ID,
    status,
    origin: 'manual',
    pageCount: '12',
    fileCount: 30,
    totalBytes: 4096,
    loss: status === 'live' ? ['mermaid-as-code: Diagram on /guide/ is shown as code.'] : [],
    failureCode: null,
    createdAt: '2026-10-11T09:00:00+00:00',
    activatedAt: status === 'live' ? '2026-10-11T09:00:05+00:00' : null,
  };
}

function site(): Record<string, unknown> {
  return {
    id: SITE_ID,
    workspaceId: WORKSPACE_ID,
    rootItemId: ITEM_ID,
    slug: 'notes',
    layout: 'docs',
    settings: {
      name: 'Notes',
      description: '',
      accent: '#3355ff', // design-token-exempt: a site owner's chosen accent, data rather than styling.
      navigation: [],
      footerText: '',
      builtWithNix: true,
      language: 'en',
    },
    republishMode: 'manual',
    debounceSeconds: 300,
    status: 'draft',
    canManage: true,
    hostnames: [
      {
        hostname: 'notes.sites.test',
        url: 'https://notes.sites.test/',
        kind: 'default',
        verified: true,
        primary: true,
        serveMode: 'serve',
        status: 'verified',
        checkedAt: null,
        checkError: null,
        managed: false,
        records: [],
      },
    ],
    excludedItemIds: [],
    datedCollections: [],
    liveBuild: null,
    latestBuild: null,
    createdAt: '2026-10-11T09:00:00+00:00',
    updatedAt: '2026-10-11T09:00:00+00:00',
    primaryHostname: null,
    approvalRequired: false,
    approval: null,
  };
}

let client: NixClient;

beforeEach(() => {
  client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
  });
});

describe('the sites resource', () => {
  it('names the cache keys the web reads and invalidates', () => {
    expect(getItemSite(ITEM_ID).cacheKey).toEqual(['items', ITEM_ID, 'site']);
    expect(createSite({ rootItemId: ITEM_ID, slug: 'notes', layout: 'docs' }).invalidates).toEqual([
      ['items', ITEM_ID, 'site'],
    ]);
    expect(deleteSite(SITE_ID, ITEM_ID).invalidates).toEqual([
      ['sites', SITE_ID],
      ['items', ITEM_ID, 'site'],
    ]);
    expect(getSiteBuild(SITE_ID, BUILD_ID).cacheKey).toEqual([
      'sites',
      SITE_ID,
      'builds',
      BUILD_ID,
    ]);
  });

  it('sends every update field, null where left alone', async () => {
    let body: unknown;
    server.use(
      http.patch(testUrl(`/api/v1/sites/${SITE_ID}`), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...site(), republishMode: 'auto' });
      }),
    );

    const updated = await client.execute(updateSite(SITE_ID, { republishMode: 'auto' }));

    expect(updated.republishMode).toBe('auto');
    expect(updated.debounceSeconds).toBe(300);
    expect(body).toEqual({
      settings: null,
      layout: null,
      republishMode: 'auto',
      debounceSeconds: null,
      excludedItemIds: null,
      datedCollections: null,
    });
  });

  it('addresses a hostname by its encoded name and sends only the fields given', async () => {
    let body: unknown;
    server.use(
      http.patch(
        testUrl(`/api/v1/sites/${SITE_ID}/hostnames/docs.example.com`),
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(site());
        },
      ),
    );

    await client.execute(updateSiteHostname(SITE_ID, 'docs.example.com', { primary: true }));

    expect(body).toEqual({ serveMode: null, primary: true });
    expect(removeSiteHostname(SITE_ID, 'docs.example.com').path).toBe(
      `/api/v1/sites/${SITE_ID}/hostnames/docs.example.com`,
    );
    expect(verifySiteHostname(SITE_ID, 'a.b').path).toBe(
      `/api/v1/sites/${SITE_ID}/hostnames/a.b/verify`,
    );
    expect(verifySiteHostname(SITE_ID, 'a.b').invalidates).toEqual([['sites', SITE_ID]]);
  });

  it('carries the disclosure acknowledgement on publish and parses digit-string counts', async () => {
    let body: unknown;
    server.use(
      http.post(testUrl(`/api/v1/sites/${SITE_ID}/publish`), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(build('queued'), { status: 202 });
      }),
    );

    const queued = await client.execute(
      publishSite(SITE_ID, { idempotencyKey: 'k1', acknowledgeDisclosure: true }),
    );

    expect(body).toEqual({
      idempotencyKey: 'k1',
      refreshPaths: false,
      acknowledgeDisclosure: true,
    });
    expect(queued.pageCount).toBe(12);
  });

  it('surfaces a reserved slug as a typed refusal', async () => {
    server.use(
      http.post(testUrl('/api/v1/sites'), () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'sites.slug_reserved',
            title: 'Request refused',
            detail: 'reserved',
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const refusal = await client
      .execute(createSite({ rootItemId: ITEM_ID, slug: 'www', layout: 'docs' }))
      .catch((error: unknown) => error);

    expect(isNixApiError(refusal)).toBe(true);
    expect(isNixApiError(refusal) && refusal.status).toBe(422);
  });

  it('waits for a build to settle, through sealed', async () => {
    const answers = ['building', 'sealed', 'live'] as const;
    let call = 0;
    server.use(
      http.get(testUrl(`/api/v1/sites/${SITE_ID}/builds/${BUILD_ID}`), () => {
        const status = answers[Math.min(call, answers.length - 1)] ?? 'live';
        call += 1;
        return HttpResponse.json(build(status));
      }),
    );
    const seen: string[] = [];

    const settled = await waitForBuild(client, build('queued') as unknown as SiteBuild, {
      initialDelayMs: 1,
      maxDelayMs: 2,
      onProgress: (state) => seen.push(state.status),
    });

    expect(settled.status).toBe('live');
    expect(settled.loss).toHaveLength(1);
    expect(seen).toEqual(['queued', 'building', 'sealed', 'live']);
  });

  it('gives up when the timeout passes first', async () => {
    server.use(
      http.get(testUrl(`/api/v1/sites/${SITE_ID}/builds/${BUILD_ID}`), () =>
        HttpResponse.json(build('building')),
      ),
    );

    await expect(
      waitForBuild(client, build('queued') as unknown as SiteBuild, {
        initialDelayMs: 5,
        maxDelayMs: 5,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/still building/);
  });
});
