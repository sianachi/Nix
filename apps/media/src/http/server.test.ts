import { createConverterRegistry, type ArchiveManifest, type ItemBundle } from '@nix/export';
import { docxConverter } from '@nix/docx-export';
import { pdfConverter } from '@nix/pdf-export';
import { afterEach, describe, expect, it } from 'vitest';

import { BundleRefusal, type BundleReader } from '../collab/bundles.ts';
import { createAdmission } from '../export/admission.ts';
import { createServer } from './server.ts';

/**
 * The media service's HTTP surface.
 *
 * **Every test here is a pure unit test, and that is a property of the isolation rather than an
 * accident.** This service holds no database, no object storage and no OIDC configuration, so there
 * is nothing to stand up: a fake bundle reader is the whole world it can see. The suite needs no
 * container and runs anywhere, which is what the no-credentials rule buys.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const MANIFEST: ArchiveManifest = {
  format: 'nix-archive',
  formatVersion: 1,
  schemaVersion: 2,
  exportedAt: '2026-08-13T00:00:00Z',
  root: ITEM,
  rootEffectiveSchema: null,
  includesDeleted: false,
  items: [{ id: ITEM, parentId: null, seq: '1000', title: 'Quarterly Review', type: 'note' }],
  omitted: [],
  loss: [],
};

function bundle(): ItemBundle {
  return {
    id: ITEM,
    parentId: null,
    workspaceId: 'c1000000-0000-4000-8000-000000000011',
    type: 'note',
    title: 'Quarterly Review',
    seq: '1000',
    lifecycleState: 'active',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    properties: {},
    schema: null,
    views: null,
    body: {
      schemaVersion: 2,
      prosemirror: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello.' }] }],
      },
    },
  };
}

async function* oneBundle(): AsyncGenerator<ItemBundle> {
  yield await Promise.resolve(bundle());
}

/** A collaboration service that answers with one readable document. */
const willing: BundleReader = {
  read: () => Promise.resolve({ manifest: MANIFEST, bundles: oneBundle() }),
};

/** One that refuses, the way it would for an item the caller may not see. */
function refusing(status: number, code: string, detail: string): BundleReader {
  return {
    read: () => Promise.reject(new BundleRefusal(status, code, detail)),
  };
}

function server(overrides: { bundles?: BundleReader; limit?: number; timeoutMs?: number } = {}) {
  const converters = createConverterRegistry();
  converters.register(pdfConverter);
  converters.register(docxConverter);

  return createServer({
    bundles: overrides.bundles ?? willing,
    converters,
    admission: createAdmission(overrides.limit ?? 4),
    jobTimeoutMs: overrides.timeoutMs ?? 30_000,
    maxOutputBytes: 64 * 1024 * 1024,
    now: () => new Date('2026-08-13T00:00:00Z'),
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

describe('saying what it is', () => {
  it('names the formats it can actually produce', async () => {
    const response = await track(server()).inject({ method: 'GET', url: '/healthz' });

    expect(response.json<{ formats: string[] }>().formats).toEqual(['pdf', 'docx']);
  });
});

describe('refusing before doing any work', () => {
  it('needs a bearer token', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
  });

  it('answers not-found for a malformed identifier, as Core does', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: '/documents/not-a-uuid/export?format=pdf',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('will not guess a format, because guessing produces the wrong file', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('unsupported_format');
    expect(response.json<{ detail: string }>().detail).toContain('pdf and docx');
  });

  it('names what it does produce when asked for something else', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=nix`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    // .nix is produced by the collaboration service, deliberately, so this is a real answer rather
    // than a gap: the format exists and this is not where it comes from.
    expect(response.json<{ detail: string }>().detail).toContain('pdf and docx');
  });

  it('refuses a scope it does not serve', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf&scope=everything`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_scope');
  });
});

describe('inventing no authority of its own', () => {
  it('forwards a refusal to authenticate unchanged, status and sentence', async () => {
    const response = await track(
      server({
        bundles: refusing(401, 'unauthenticated', 'The token could not be validated.'),
      }),
    ).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('unauthenticated');
    // The other service made the decision, so it owns the wording. Rewriting it here would be this
    // service having an opinion about a permission it did not evaluate.
    expect(response.json<{ detail: string }>().detail).toBe('The token could not be validated.');
  });

  it('forwards a not-found unchanged rather than turning it into a server error', async () => {
    const response = await track(
      server({ bundles: refusing(404, 'document_not_found', 'No such item.') }),
    ).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('document_not_found');
  });
});

describe('producing a file', () => {
  it('answers with a PDF, named after the document', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="quarterly-review.pdf"',
    );
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('answers with a Word document when asked for one', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=docx`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="quarterly-review.docx"',
    );
    // A zip's local file header. Word's package is a zip and this is the first thing in one.
    expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('says how much it carried and what the format cannot carry, before the bytes', async () => {
    const response = await track(server()).inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.headers['x-nix-export-items']).toBe('1');
    expect(response.headers['x-nix-export-omitted']).toBe('0');
    // The declared count: what a PDF cannot carry, knowable before a node is read. What this
    // document actually lost is written into the file, because the headers are long gone by then.
    expect(Number(response.headers['x-nix-export-loss'])).toBeGreaterThan(0);
  });
});

describe('when it is already as busy as it can be', () => {
  it('says so with a retry-after rather than accepting work it cannot do', async () => {
    const app = track(server({ limit: 0 }));

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${ITEM}/export?format=pdf`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('busy');
    expect(response.headers['retry-after']).toBe('5');
  });
});
