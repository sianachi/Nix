import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import type { Authorizer } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import type { CoreClient } from '../core/client.ts';
import type { ImportBodyService } from '../imports/bodies.ts';
import type { TemplateImportBodyService } from '../template-imports/bodies.ts';
import type { TemplateService } from '../templates/service.ts';
import { TemplateBodyError } from '../templates/bodies.ts';
import {
  TranscriptionAppendError,
  type TranscriptionAppendService,
} from '../transcriptions/append.ts';
import { CoreTranscriptionError } from '../transcriptions/core.ts';
import type { SessionHub } from '../ws/server.ts';
import { createSessionAuthenticator } from '../ws/session-auth.ts';
import { createServer } from './server.ts';

/**
 * The HTTP surface's refusals, with no database behind it.
 *
 * Every test here is about a request that must never reach Postgres: no token, a token that
 * does not validate, an item Core refused, or a writer who is only a reader. The pool is a
 * proxy that throws if anything touches it, so "did not reach the database" is asserted
 * rather than assumed.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const GRANTED = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
} as const;

/** A pool that fails loudly. Reaching it at all is the bug these tests look for. */
const refusingPool = new Proxy({} as Pool, {
  get() {
    throw new Error('The request reached the database, which it should have been refused before.');
  },
});

/**
 * A Core that answers nothing.
 *
 * The export tests here are all about requests refused before any tree is walked, so a client that
 * returns null for everything is the honest fake: reaching it would mean the refusal did not
 * happen, and a null root produces the same 404 those tests already expect.
 */
const silentCore: CoreClient = {
  getItem: () => Promise.resolve(null),
  listChildren: () => Promise.resolve(null),
  getSchema: () => Promise.resolve(null),
  getViews: () => Promise.resolve(null),
};

const INTERNAL_SECRET = 'test-internal-secret';

function server(overrides: {
  tokens?: TokenValidator;
  authorizer?: Authorizer;
  pool?: Pool;
  core?: CoreClient;
  importBodies?: ImportBodyService;
  templateImportBodies?: TemplateImportBodyService;
  templates?: TemplateService;
  transcriptions?: TranscriptionAppendService;
  hub?: SessionHub;
}) {
  return createServer({
    pool: overrides.pool ?? refusingPool,
    sessions: createSessionAuthenticator({
      tokens: overrides.tokens ?? {
        validate: () => Promise.resolve({ subject: 'subject', expiresAt: null }),
      },
      authorizer: overrides.authorizer ?? { authorize: () => Promise.resolve(null) },
    }),
    core: overrides.core ?? silentCore,
    internalSecret: INTERNAL_SECRET,
    ...(overrides.importBodies === undefined ? {} : { importBodies: overrides.importBodies }),
    ...(overrides.templateImportBodies === undefined
      ? {}
      : { templateImportBodies: overrides.templateImportBodies }),
    ...(overrides.templates === undefined ? {} : { templates: overrides.templates }),
    ...(overrides.transcriptions === undefined ? {} : { transcriptions: overrides.transcriptions }),
    ...(overrides.hub === undefined ? {} : { hub: overrides.hub }),
  });
}

const instances: { close: () => Promise<unknown> }[] = [];

function track<T extends { close: () => Promise<unknown> }>(app: T): T {
  instances.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('the collaboration service HTTP surface', () => {
  it('forwards an approved capture fingerprint to the template service', async () => {
    let captured: unknown;
    const templates = {
      capture: (_token: string, request: unknown) => {
        captured = request;
        return Promise.resolve({ templateId: ITEM });
      },
    } as unknown as TemplateService;
    const app = track(server({ templates }));
    const response = await app.inject({
      method: 'POST',
      url: '/templates/captures',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        workspaceId: GRANTED.workspaceId,
        sourceItemId: ITEM,
        title: 'Pinned capture',
        includeBody: true,
        includeChildren: true,
        idempotencyKey: 'pinned-capture',
        expectedFingerprint: 'approved-snapshot',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(captured).toMatchObject({ expectedFingerprint: 'approved-snapshot' });
  });

  it('returns a conflict when a pinned capture source body changed', async () => {
    const templates = {
      capture: () =>
        Promise.reject(
          new TemplateBodyError(
            'templates.conflict',
            'The source body changed since capture began.',
          ),
        ),
    } as unknown as TemplateService;
    const app = track(server({ templates }));
    const response = await app.inject({
      method: 'POST',
      url: '/templates/captures',
      headers: { authorization: 'Bearer valid' },
      payload: {
        workspaceId: GRANTED.workspaceId,
        sourceItemId: ITEM,
        title: 'Pinned capture',
        includeBody: true,
        includeChildren: false,
        idempotencyKey: 'pinned-capture',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'templates.conflict' });
  });

  it('reports its schema version on the health endpoint', async () => {
    const app = track(server({}));

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'healthy' });
  });

  it('forwards draft initialization through the authenticated template HTTP route', async () => {
    const initialization = {
      version: 1 as const,
      inputs: [
        {
          key: 'lead',
          label: 'Project lead',
          type: 'member' as const,
          required: true,
          defaultValue: ITEM,
        },
      ],
      rules: [],
      references: [],
    };
    let patchReceived: unknown;
    const templates = {
      patchDraft: (_token: string, _templateId: string, _operationId: string, body: unknown) => {
        patchReceived = body;
        return Promise.resolve({ initialization });
      },
    } as unknown as TemplateService;
    const app = track(server({ templates }));
    const response = await app.inject({
      method: 'PATCH',
      url: `/templates/${ITEM}/drafts/${ITEM}`,
      headers: { authorization: 'Bearer valid' },
      payload: { initialization },
    });
    expect(response.statusCode).toBe(200);
    expect(patchReceived).toEqual({ initialization });
    expect(response.json()).toEqual({ initialization });
  });

  it('refuses a request with no bearer token', async () => {
    const app = track(server({}));

    const response = await app.inject({ method: 'GET', url: `/documents/${ITEM}/updates` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a token that does not validate', async () => {
    const app = track(server({ tokens: { validate: () => Promise.resolve(null) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer forged' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reports an item Core refused as not found, never as forbidden', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(null) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    // Matching Core exactly. "You may not see this" confirms the thing exists, which is how
    // an outsider enumerates a workspace one identifier at a time.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'document_not_found' });
  });

  it('answers 503 with a retry when Core could not be asked, never a refusal', async () => {
    const app = track(
      server({ authorizer: { authorize: () => Promise.resolve('unavailable' as const) } }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.json()).toMatchObject({ code: 'authorization_unavailable' });
  });

  it('refuses a malformed item identifier the same way', async () => {
    const app = track(server({}));

    const response = await app.inject({
      method: 'GET',
      url: '/documents/not-a-uuid/updates',
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('never asks Core about an item when the token is bad', async () => {
    let asked = 0;
    const app = track(
      server({
        tokens: { validate: () => Promise.resolve(null) },
        authorizer: {
          authorize: () => {
            asked += 1;
            return Promise.resolve(null);
          },
        },
      }),
    );

    await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer forged' },
      payload: { update: 'AAAA', clientId: 'client' },
    });

    // Authentication first, then authorization. Reversed, an unauthenticated caller could
    // make this service hammer Core on their behalf.
    expect(asked).toBe(0);
  });

  it('refuses a write from a principal Core says may only read', async () => {
    const app = track(
      server({
        authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { update: 'AAAA', clientId: 'client' },
    });

    // Forbidden rather than not-found: a reader already knows the item exists, and "you may
    // see this and not change it" is the answer they can act on. The pool proxy guarantees
    // the refused write never reached the log.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'read_only' });
  });

  it('still lets a reader catch up on a document they may not write', async () => {
    // Reads reach the database, so this needs a pool - but the refusal under test happens
    // before that. A reader hitting 'read_only' on GET would be the bug.
    let touchedPool = false;
    const observingPool = new Proxy({} as Pool, {
      get() {
        touchedPool = true;
        throw new Error('stop here; the authorization already passed');
      },
    });

    const app = track(
      server({
        pool: observingPool,
        authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(touchedPool).toBe(true);
    expect(response.statusCode).not.toBe(403);
  });

  it('refuses a body that is not an update at all', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { nonsense: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
  });

  it('refuses an update that is not valid base64 before decoding it', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    // Buffer.from silently drops what it cannot parse, so a payload with a typo would
    // otherwise decode to a shorter buffer and be applied as though it were what was sent.
    const response = await app.inject({
      method: 'POST',
      url: `/documents/${ITEM}/updates`,
      headers: { authorization: 'Bearer valid' },
      payload: { update: 'not base64 at all!!', clientId: 'client' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a cursor that is not a sequence', async () => {
    const app = track(server({ authorizer: { authorize: () => Promise.resolve(GRANTED) } }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/updates?after=yesterday`,
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_cursor' });
  });

  it('serves metrics when given a registry', async () => {
    const { createMetrics } = await import('../metrics.ts');
    const app = track(
      createServer({
        pool: refusingPool,
        sessions: createSessionAuthenticator({
          tokens: { validate: () => Promise.resolve(null) },
          authorizer: { authorize: () => Promise.resolve(null) },
        }),
        core: silentCore,
        internalSecret: INTERNAL_SECRET,
        metrics: createMetrics(),
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('nix_collab_open_sockets');
  });
});

describe('staged import bodies', () => {
  it('is invisible without the service secret', async () => {
    let called = false;
    const app = track(
      server({
        importBodies: {
          write: () => {
            called = true;
            return Promise.resolve({ written: 1 });
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/internal/imports/${ITEM}/bodies`,
      headers: {
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: { writes: [] },
    });

    expect(response.statusCode).toBe(404);
    expect(called).toBe(false);
  });

  it('passes the exact worker execution proof to the staged body service', async () => {
    const seen: unknown[] = [];
    const app = track(
      server({
        importBodies: {
          write: (input) => {
            seen.push(input);
            return Promise.resolve({ written: 1 });
          },
        },
      }),
    );
    const body = {
      writes: [{ sourceId: 'root', body: { encoding: 'plain_text', text: 'Imported' } }],
    };

    const response = await app.inject({
      method: 'POST',
      url: `/internal/imports/${ITEM}/bodies`,
      headers: {
        'x-nix-internal-secret': INTERNAL_SECRET,
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ written: 1 });
    expect(seen).toEqual([
      {
        importId: ITEM,
        jobId: ITEM,
        executionId: 'worker:execution',
        body,
      },
    ]);
  });
});

describe('worker-fenced template import bodies', () => {
  it('requires the internal secret and both worker execution headers', async () => {
    let called = false;
    const app = track(
      server({
        templateImportBodies: {
          write: () => {
            called = true;
            return Promise.resolve({ writtenTargetItemIds: [ITEM] });
          },
        },
      }),
    );
    const body = { writes: [] };

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
        headers: {
          'x-nix-worker-job-id': ITEM,
          'x-nix-worker-execution-id': 'worker:execution',
        },
        payload: body,
      }),
      app.inject({
        method: 'POST',
        url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
        headers: {
          'x-nix-internal-secret': INTERNAL_SECRET,
          'x-nix-worker-execution-id': 'worker:execution',
        },
        payload: body,
      }),
      app.inject({
        method: 'POST',
        url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
        headers: {
          'x-nix-internal-secret': INTERNAL_SECRET,
          'x-nix-worker-job-id': ITEM,
        },
        payload: body,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(called).toBe(false);
  });

  it('accepts exact worker proof without requiring a bearer token', async () => {
    const seen: unknown[] = [];
    const app = track(
      server({
        templateImportBodies: {
          write: (input) => {
            seen.push(input);
            return Promise.resolve({ writtenTargetItemIds: [ITEM] });
          },
        },
      }),
    );
    const body = { writes: [{ sourceId: 'root', body: { schemaVersion: 2 } }] };

    const response = await app.inject({
      method: 'POST',
      url: `/internal/worker-executions/template-imports/${ITEM}/bodies`,
      headers: {
        'x-nix-internal-secret': INTERNAL_SECRET,
        'x-nix-worker-job-id': ITEM,
        'x-nix-worker-execution-id': 'worker:execution',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ writtenTargetItemIds: [ITEM] });
    expect(seen).toEqual([
      {
        importId: ITEM,
        jobId: ITEM,
        executionId: 'worker:execution',
        body,
      },
    ]);
  });
});

describe('the worker-fenced transcript append', () => {
  const URL = '/internal/worker-executions/transcriptions/append';
  const JOB = 'c1000000-0000-4000-8000-0000000000a1';
  const PROOF = {
    'x-nix-internal-secret': INTERNAL_SECRET,
    'x-nix-worker-job-id': JOB,
    'x-nix-worker-execution-id': 'worker:execution',
  };
  const TRANSCRIPT = {
    durationMillis: 61_000,
    paragraphs: [{ startMillis: 0, speaker: 'me', text: 'Shall we start?' }],
  };

  /** A hub that only records which items it was told to bring up to date. */
  function recordingHub(refreshed: string[]): SessionHub {
    return {
      join: () => Promise.resolve({ ok: false, closeCode: 1011, reason: 'not under test' }),
      handleMessage: () => undefined,
      leave: () => undefined,
      refresh: (itemId) => {
        refreshed.push(itemId);
        return Promise.resolve();
      },
    };
  }

  it('answers not-found without the secret, a uuid job, or an execution', async () => {
    let called = false;
    const app = track(
      server({
        transcriptions: {
          append: () => {
            called = true;
            return Promise.resolve({ appended: true, paragraphs: 1, noteItemId: ITEM });
          },
        },
      }),
    );
    const without = (name: keyof typeof PROOF, replacement?: string) => {
      const headers: Record<string, string> = { ...PROOF };
      if (replacement === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete headers[name];
      } else {
        headers[name] = replacement;
      }
      return app.inject({ method: 'POST', url: URL, headers, payload: TRANSCRIPT });
    };

    const responses = await Promise.all([
      without('x-nix-internal-secret'),
      without('x-nix-internal-secret', 'wrong-secret'),
      without('x-nix-worker-job-id'),
      without('x-nix-worker-job-id', 'not-a-uuid'),
      without('x-nix-worker-execution-id'),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(responses.map((response) => response.json<{ code: string }>().code)).toEqual(
      Array.from({ length: 5 }, () => 'transcription_not_found'),
    );
    expect(called).toBe(false);
  });

  it('no longer answers at the path outside the worker-execution routes', async () => {
    const app = track(
      server({
        transcriptions: {
          append: () => Promise.resolve({ appended: true, paragraphs: 1, noteItemId: ITEM }),
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/internal/transcriptions/append',
      headers: PROOF,
      payload: TRANSCRIPT,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code?: string }>().code).not.toBe('transcription_not_found');
  });

  it('is not registered when the service is not configured', async () => {
    const response = await track(server({})).inject({
      method: 'POST',
      url: URL,
      headers: PROOF,
      payload: TRANSCRIPT,
    });

    expect(response.statusCode).toBe(404);
  });

  it('appends on worker proof alone, refreshes the open note, and keeps the note id to itself', async () => {
    const seen: unknown[] = [];
    const refreshed: string[] = [];
    const app = track(
      server({
        hub: recordingHub(refreshed),
        transcriptions: {
          append: (input) => {
            seen.push(input);
            return Promise.resolve({ appended: true, paragraphs: 1, noteItemId: ITEM });
          },
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: PROOF,
      payload: TRANSCRIPT,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ appended: true, paragraphs: 1 });
    expect(seen).toEqual([{ jobId: JOB, executionId: 'worker:execution', body: TRANSCRIPT }]);
    expect(refreshed).toEqual([ITEM]);
  });

  it('reports a retry that changed nothing and refreshes nobody', async () => {
    const refreshed: string[] = [];
    const app = track(
      server({
        hub: recordingHub(refreshed),
        transcriptions: {
          append: () => Promise.resolve({ appended: false, paragraphs: 1, noteItemId: ITEM }),
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: PROOF,
      payload: TRANSCRIPT,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ appended: false, paragraphs: 1 });
    expect(refreshed).toEqual([]);
  });

  it('still succeeds when the open note cannot be refreshed: the write has committed', async () => {
    const hub = recordingHub([]);
    const app = track(
      server({
        hub: { ...hub, refresh: () => Promise.reject(new Error('lock session lost')) },
        transcriptions: {
          append: () => Promise.resolve({ appended: true, paragraphs: 1, noteItemId: ITEM }),
        },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: PROOF,
      payload: TRANSCRIPT,
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    [new TranscriptionAppendError(400, 'transcription_invalid', 'Bad transcript.')],
    [new TranscriptionAppendError(409, 'transcription_note_locked', 'Locked.')],
    [new TranscriptionAppendError(409, 'transcription_note_unsupported', 'Not prose.')],
    [new TranscriptionAppendError(413, 'transcription_too_large', 'Too large.')],
    [new CoreTranscriptionError(409, 'transcription_execution_lost', 'Lease lost.')],
    [new CoreTranscriptionError(403, 'transcription_authorization_refused', 'Refused.')],
    [new CoreTranscriptionError(503, 'transcription_core_unavailable', 'Core is away.')],
  ])('turns a service refusal into a problem response: %s', async (refusal) => {
    const refreshed: string[] = [];
    const app = track(
      server({
        hub: recordingHub(refreshed),
        transcriptions: { append: () => Promise.reject(refusal) },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      headers: PROOF,
      payload: TRANSCRIPT,
    });

    expect(response.statusCode).toBe(refusal.status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json<{ code: string }>().code).toBe(refusal.code);
    expect(refreshed).toEqual([]);
  });

  it('accepts a transcript larger than the default body limit', async () => {
    let paragraphs = 0;
    const app = track(
      server({
        transcriptions: {
          append: (input) => {
            paragraphs = (input.body as { paragraphs: unknown[] }).paragraphs.length;
            return Promise.resolve({ appended: true, paragraphs, noteItemId: ITEM });
          },
        },
      }),
    );
    // About 3 MiB: over the server-wide 2 MiB default, under this route's 4 MiB.
    const large = {
      durationMillis: 1,
      paragraphs: Array.from({ length: 800 }, () => ({
        startMillis: 0,
        speaker: '',
        text: 'x'.repeat(3_900),
      })),
    };

    const response = await app.inject({ method: 'POST', url: URL, headers: PROOF, payload: large });

    expect(response.statusCode).toBe(200);
    expect(paragraphs).toBe(800);
  });
});

/**
 * The export routes.
 *
 * The archive route is the one the web client already points at; the bundles route is the internal
 * surface the Go export worker reads to convert a document into a format this process does not know
 * about. Both refuse before touching the database, which is why they belong in this file.
 */
describe('exporting', () => {
  const granting: Authorizer = { authorize: () => Promise.resolve(GRANTED) };

  it('refuses an archive with no bearer token', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
  });

  it('directs lossy formats to the durable Go export workflow', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('unsupported_format');
    // A wrong-service call gets told which service to ask, rather than a bare 404.
    expect(response.json<{ detail: string }>().detail).toContain('Go worker jobs');
  });

  it('refuses a scope it does not serve', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?scope=everything`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_scope');
  });

  it('answers not-found for an item Core will not show the caller', async () => {
    // silentCore returns null for getItem, which is what Core gives for an item the caller may not
    // read - so an export of somebody else's document is indistinguishable from one that is gone.
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('the bundle stream', () => {
  const granting: Authorizer = { authorize: () => Promise.resolve(GRANTED) };

  it('is invisible without the internal secret, answering not-found rather than forbidden', async () => {
    // 403 would confirm the route exists to anybody who found the URL. Core's internal surface
    // answers 404 to everything for the same reason, and these two have to agree.
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('document_not_found');
  });

  it('is invisible with the wrong internal secret', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { authorization: 'Bearer token', 'x-nix-internal-secret': 'not-the-secret' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers the same not-found for missing and wrong secrets of any length', async () => {
    const app = track(server({ authorizer: granting }));
    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/documents/${ITEM}/bundles`,
        headers: { authorization: 'Bearer token' },
      }),
      app.inject({
        method: 'GET',
        url: `/documents/${ITEM}/bundles`,
        headers: { authorization: 'Bearer token', 'x-nix-internal-secret': 'x' },
      }),
      app.inject({
        method: 'GET',
        url: `/documents/${ITEM}/bundles`,
        headers: {
          authorization: 'Bearer token',
          'x-nix-internal-secret': 'x'.repeat(INTERNAL_SECRET.length),
        },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(responses.map((response) => response.body)).toEqual([
      responses[0].body,
      responses[0].body,
      responses[0].body,
    ]);
  });

  it('still needs the caller own token, so a service cannot export on nobody behalf', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { 'x-nix-internal-secret': INTERNAL_SECRET },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
  });

  it('refuses when Core will not show the caller the item, secret or no secret', async () => {
    const response = await track(server({ authorizer: granting })).inject({
      method: 'GET',
      url: `/documents/${ITEM}/bundles`,
      headers: { authorization: 'Bearer token', 'x-nix-internal-secret': INTERNAL_SECRET },
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * Version history: the six routes, refused or validated the same way the rest of this surface
 * is - before the database is ever touched, wherever a refusal does not itself require reading
 * from it.
 */
describe('version history', () => {
  const granting: Authorizer = { authorize: () => Promise.resolve(GRANTED) };
  const readOnly: Authorizer = {
    authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }),
  };

  /** A pool that lets authorization pass and then observes whether anything reached it. */
  function observing(): { pool: Pool; touched: () => boolean } {
    let touched = false;
    const pool = new Proxy({} as Pool, {
      get() {
        touched = true;
        throw new Error('stop here; the authorization already passed');
      },
    });
    return { pool, touched: () => touched };
  }

  describe('GET /documents/:itemId/history', () => {
    it('refuses a request with no bearer token', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/history`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('refuses a before cursor that is not a sequence', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/history?before=soon`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('history_seq_invalid');
    });

    it('lets a reader list history - reading never needed canWrite', async () => {
      const { pool, touched } = observing();
      const response = await track(server({ pool, authorizer: readOnly })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/history`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(touched()).toBe(true);
      expect(response.statusCode).not.toBe(403);
    });
  });

  describe('GET /documents/:itemId/history/:seq', () => {
    it('refuses a seq that is not a non-negative integer', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/history/not-a-seq`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('history_seq_invalid');
    });

    it('refuses a negative seq', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/history/-1`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('history_seq_invalid');
    });

    it('lets a reader ask for a state - reading never needed canWrite', async () => {
      const { pool, touched } = observing();
      const response = await track(server({ pool, authorizer: readOnly })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/history/3`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(touched()).toBe(true);
      expect(response.statusCode).not.toBe(403);
    });
  });

  describe('POST /documents/:itemId/history/:seq/restore', () => {
    it('refuses a restore from a reader who may not write', async () => {
      const response = await track(server({ authorizer: readOnly })).inject({
        method: 'POST',
        url: `/documents/${ITEM}/history/1/restore`,
        headers: { authorization: 'Bearer valid' },
      });

      // The pool proxy guarantees a refused restore never reached the log, same as the
      // ordinary update path.
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('read_only');
    });

    it('refuses a seq that is not a non-negative integer, before touching the database', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'POST',
        url: `/documents/${ITEM}/history/not-a-seq/restore`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('history_seq_invalid');
    });
  });

  describe('GET /documents/:itemId/versions', () => {
    it('refuses a request with no bearer token', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/versions`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('lets a reader list named versions - reading never needed canWrite', async () => {
      const { pool, touched } = observing();
      const response = await track(server({ pool, authorizer: readOnly })).inject({
        method: 'GET',
        url: `/documents/${ITEM}/versions`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(touched()).toBe(true);
      expect(response.statusCode).not.toBe(403);
    });
  });

  describe('POST /documents/:itemId/versions', () => {
    it('refuses naming from a reader who may not write', async () => {
      const response = await track(server({ authorizer: readOnly })).inject({
        method: 'POST',
        url: `/documents/${ITEM}/versions`,
        headers: { authorization: 'Bearer valid' },
        payload: { seq: 1, name: 'Draft' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('read_only');
    });

    it('refuses a seq that is not a non-negative integer', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'POST',
        url: `/documents/${ITEM}/versions`,
        headers: { authorization: 'Bearer valid' },
        payload: { seq: 'not-a-seq', name: 'Draft' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('history_seq_invalid');
    });

    it('refuses an empty name', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'POST',
        url: `/documents/${ITEM}/versions`,
        headers: { authorization: 'Bearer valid' },
        payload: { seq: 1, name: '   ' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('version_name_invalid');
    });

    it('refuses a name over 120 characters', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'POST',
        url: `/documents/${ITEM}/versions`,
        headers: { authorization: 'Bearer valid' },
        payload: { seq: 1, name: 'x'.repeat(121) },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('version_name_invalid');
    });
  });

  describe('DELETE /documents/:itemId/versions/:seq', () => {
    it('refuses removing a name from a reader who may not write', async () => {
      const response = await track(server({ authorizer: readOnly })).inject({
        method: 'DELETE',
        url: `/documents/${ITEM}/versions/1`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('read_only');
    });

    it('refuses a seq that is not a non-negative integer', async () => {
      const response = await track(server({ authorizer: granting })).inject({
        method: 'DELETE',
        url: `/documents/${ITEM}/versions/not-a-seq`,
        headers: { authorization: 'Bearer valid' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('history_seq_invalid');
    });
  });
});
