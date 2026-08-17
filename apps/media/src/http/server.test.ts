import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  TEMPLATE_PROFILE_VERSION,
  createConverterRegistry,
  writeArchive,
  type ArchiveManifest,
  type ItemBundle,
} from '@nix/export';
import { docxConverter } from '@nix/docx-export';
import { pdfConverter } from '@nix/pdf-export';
import { afterEach, describe, expect, it } from 'vitest';

import { BundleRefusal, type BundleReader } from '../collab/bundles.ts';
import { TemplateImportRefusal, type TemplateImporter } from '../collab/templates.ts';
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
const IMPORT_AUTHORIZATION = {
  workspaceId: ITEM,
  tenantId: 'c1000000-0000-4000-8000-000000000032',
  principalId: 'c1000000-0000-4000-8000-000000000033',
  canWrite: true,
  canManageTemplates: false,
};
const TEMPLATE_VALIDATION = { itemCount: 1, bodyCount: 1 } as const;
const STAGED_TEMPLATE = {
  operationId: ITEM,
  templateId: ITEM,
  stableKey: 'quarterly.review',
  digest: '0'.repeat(64),
  unchanged: false,
  writtenTargetItemIds: [],
} as const;
const MANAGED_RESULT = { activated: 0, unchanged: 0, retired: 0 } as const;
const EMPTY_SWEEP = { removed: 0, itemIds: [] } as const;

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
    viewRows: [],
    viewRowsTruncated: false,
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

function server(
  overrides: {
    bundles?: BundleReader;
    limit?: number;
    timeoutMs?: number;
    templates?: TemplateImporter;
    templateReadTimeoutMs?: number;
    templateLimit?: number;
  } = {},
) {
  const converters = createConverterRegistry();
  converters.register(pdfConverter);
  converters.register(docxConverter);

  return createServer({
    bundles: overrides.bundles ?? willing,
    converters,
    admission: createAdmission(overrides.limit ?? 4),
    templateAdmission: createAdmission(overrides.templateLimit ?? 2),
    jobTimeoutMs: overrides.timeoutMs ?? 30_000,
    maxOutputBytes: 64 * 1024 * 1024,
    now: () => new Date('2026-08-13T00:00:00Z'),
    templates: overrides.templates,
    templateReadTimeoutMs: overrides.templateReadTimeoutMs,
  });
}

async function archiveBytes(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const manifest: ArchiveManifest = {
    ...MANIFEST,
    profile: {
      kind: 'template',
      version: TEMPLATE_PROFILE_VERSION,
      key: 'quarterly.review',
      name: 'Quarterly review',
      description: 'A review starting point.',
      includeBody: true,
      includeChildren: false,
    },
  };
  // eslint-disable-next-line @typescript-eslint/require-await -- the archive writer consumes an async source.
  async function* bundles(): AsyncGenerator<ItemBundle> {
    yield bundle();
  }
  for await (const chunk of writeArchive({ manifest, bundles: bundles() })) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

describe('admitting template files', () => {
  it('previews a bounded native template after workspace admission', async () => {
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: () => Promise.reject(new Error('Preview must not import.')),
      stageTemplate: () => Promise.reject(new Error('Preview must not stage.')),
      finalizeManaged: () => Promise.reject(new Error('Preview must not finalize.')),
      abortStage: () => Promise.reject(new Error('Preview must not abort.')),
      sweepExpired: () => Promise.reject(new Error('Preview must not sweep.')),
    };
    const response = await track(server({ templates })).inject({
      method: 'POST',
      url: `/templates/preview?workspaceId=${ITEM}`,
      headers: { authorization: 'Bearer token', 'content-type': 'application/zip' },
      payload: Buffer.from(await archiveBytes()),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: { key: 'quarterly.review' },
      itemCount: 1,
      bodyCount: 1,
    });
  });

  it('refuses an invalid token before reading archive bytes', async () => {
    const templates: TemplateImporter = {
      authorizePreview: () =>
        Promise.reject(
          new TemplateImportRefusal(401, 'unauthenticated', 'The token could not be validated.'),
        ),
      validateTemplate: () => Promise.reject(new Error('A refused preview must not validate.')),
      importTemplate: () => Promise.reject(new Error('A refused preview must not import.')),
      stageTemplate: () => Promise.reject(new Error('A refused preview must not stage.')),
      finalizeManaged: () => Promise.reject(new Error('A refused preview must not finalize.')),
      abortStage: () => Promise.reject(new Error('A refused preview must not abort.')),
      sweepExpired: () => Promise.reject(new Error('A refused preview must not sweep.')),
    };
    const response = await track(server({ templates })).inject({
      method: 'POST',
      url: `/templates/preview?workspaceId=${ITEM}`,
      headers: { authorization: 'Bearer expired', 'content-type': 'application/zip' },
      payload: Buffer.from('not a zip'),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('commits only the parsed plan and digest to collaboration', async () => {
    let receivedKey = '';
    const idempotencyKeys: string[] = [];
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: (_token, request) => {
        receivedKey = request.profile.key;
        idempotencyKeys.push(request.idempotencyKey);
        return Promise.resolve({
          ...STAGED_TEMPLATE,
          stableKey: request.profile.key,
        });
      },
      stageTemplate: () => Promise.resolve(STAGED_TEMPLATE),
      finalizeManaged: () => Promise.resolve(MANAGED_RESULT),
      abortStage: () => Promise.resolve(),
      sweepExpired: () => Promise.resolve(EMPTY_SWEEP),
    };
    const bytes = await archiveBytes();
    const response = await track(server({ templates })).inject({
      method: 'POST',
      url: `/templates/commit?workspaceId=${ITEM}&origin=user`,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/zip',
        'x-nix-template-digest': createHash('sha256').update(bytes).digest('hex'),
      },
      payload: Buffer.from(bytes),
    });

    expect(response.statusCode).toBe(201);
    expect(receivedKey).toBe('quarterly.review');
    expect(response.json()).toMatchObject({ stableKey: 'quarterly.review' });

    const second = await track(server({ templates })).inject({
      method: 'POST',
      url: `/templates/commit?workspaceId=${ITEM}&origin=user`,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/zip',
        'x-nix-template-digest': createHash('sha256').update(bytes).digest('hex'),
      },
      payload: Buffer.from(bytes),
    });
    expect(second.statusCode).toBe(201);
    expect(idempotencyKeys[0]).not.toBe(idempotencyKeys[1]);
  });

  it('refuses a user file that changed after preview', async () => {
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: () => Promise.reject(new Error('A changed file must not be staged.')),
      stageTemplate: () => Promise.resolve(STAGED_TEMPLATE),
      finalizeManaged: () => Promise.resolve(MANAGED_RESULT),
      abortStage: () => Promise.resolve(),
      sweepExpired: () => Promise.resolve(EMPTY_SWEEP),
    };
    const response = await track(server({ templates })).inject({
      method: 'POST',
      url: `/templates/commit?workspaceId=${ITEM}&origin=user`,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/zip',
        'x-nix-template-digest': '0'.repeat(64),
      },
      payload: Buffer.from(await archiveBytes()),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'template.file_changed' });
  });

  it('refuses a user commit before consuming bytes when workspace admission fails', async () => {
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve({ ...IMPORT_AUTHORIZATION, canWrite: false }),
      validateTemplate: () => Promise.reject(new Error('A refused commit must not validate.')),
      importTemplate: () => Promise.reject(new Error('A refused commit must not import.')),
      stageTemplate: () => Promise.reject(new Error('A refused commit must not stage.')),
      finalizeManaged: () => Promise.reject(new Error('A refused commit must not finalize.')),
      abortStage: () => Promise.reject(new Error('A refused commit must not abort.')),
      sweepExpired: () => Promise.reject(new Error('A refused commit must not sweep.')),
    };
    const response = await track(server({ templates })).inject({
      method: 'POST',
      url: `/templates/commit?workspaceId=${ITEM}`,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/zip',
        'x-nix-template-digest': '0'.repeat(64),
      },
      payload: Buffer.from('not a zip'),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'template.import_forbidden' });
  });

  it('allows only the managed-template service to spend parser work on a managed stage', async () => {
    const human: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: () => Promise.reject(new Error('A managed stage must not user-import.')),
      stageTemplate: () => Promise.reject(new Error('A human stage must be refused first.')),
      finalizeManaged: () => Promise.reject(new Error('A human stage must not finalize.')),
      abortStage: () => Promise.reject(new Error('A human stage must not abort.')),
      sweepExpired: () => Promise.reject(new Error('A human stage must not sweep.')),
    };
    const refused = await track(server({ templates: human })).inject({
      method: 'POST',
      url: `/templates/managed/stage?workspaceId=${ITEM}&managedSource=alpha.nix`,
      headers: { authorization: 'Bearer human', 'content-type': 'application/zip' },
      payload: Buffer.from('not a zip'),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'template.managed_forbidden' });

    let staged = false;
    const machine: TemplateImporter = {
      ...human,
      authorizePreview: () =>
        Promise.resolve({ ...IMPORT_AUTHORIZATION, canManageTemplates: true }),
      stageTemplate: () => {
        staged = true;
        return Promise.resolve(STAGED_TEMPLATE);
      },
    };
    const admitted = await track(server({ templates: machine })).inject({
      method: 'POST',
      url: `/templates/managed/stage?workspaceId=${ITEM}&managedSource=alpha.nix`,
      headers: { authorization: 'Bearer service', 'content-type': 'application/zip' },
      payload: Buffer.from(await archiveBytes()),
    });
    expect(admitted.statusCode).toBe(202);
    expect(staged).toBe(true);
  });

  it('allows only the managed-template service to activate a managed batch', async () => {
    const human: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: () => Promise.reject(new Error('Managed finalize must not user-import.')),
      stageTemplate: () => Promise.reject(new Error('Managed finalize must not stage.')),
      finalizeManaged: () =>
        Promise.reject(new Error('A human batch must be refused at admission.')),
      abortStage: () => Promise.reject(new Error('Managed finalize must not abort.')),
      sweepExpired: () => Promise.reject(new Error('Managed finalize must not sweep.')),
    };
    const payload = { imports: [], activeStableKeys: [] };
    const refused = await track(server({ templates: human })).inject({
      method: 'POST',
      url: `/workspaces/${ITEM}/templates/managed/finalize`,
      headers: { authorization: 'Bearer human', 'content-type': 'application/json' },
      payload,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'template.managed_forbidden' });

    let finalized = false;
    const machine: TemplateImporter = {
      ...human,
      authorizePreview: () =>
        Promise.resolve({ ...IMPORT_AUTHORIZATION, canManageTemplates: true }),
      finalizeManaged: () => {
        finalized = true;
        return Promise.resolve({ activated: 0, unchanged: 0, retired: 0 });
      },
    };
    const admitted = await track(server({ templates: machine })).inject({
      method: 'POST',
      url: `/workspaces/${ITEM}/templates/managed/finalize`,
      headers: { authorization: 'Bearer service', 'content-type': 'application/json' },
      payload,
    });
    expect(admitted.statusCode).toBe(200);
    expect(finalized).toBe(true);
  });

  it('stops reading a template upload at the configured deadline', async () => {
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: () => Promise.reject(new Error('A timed-out file must not be imported.')),
      stageTemplate: () => Promise.reject(new Error('A timed-out file must not be staged.')),
      finalizeManaged: () => Promise.reject(new Error('A timed-out file must not be finalized.')),
      abortStage: () => Promise.reject(new Error('A timed-out file has no stage to abort.')),
      sweepExpired: () => Promise.reject(new Error('A timed-out file must not sweep.')),
    };
    async function* delayed(): AsyncGenerator<Uint8Array> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield await archiveBytes();
    }
    const response = await track(server({ templates, templateReadTimeoutMs: 1 })).inject({
      method: 'POST',
      url: `/templates/preview?workspaceId=${ITEM}`,
      headers: { authorization: 'Bearer token', 'content-type': 'application/zip' },
      payload: Readable.from(delayed()),
    });

    expect(response.statusCode).toBe(408);
    expect(response.json()).toMatchObject({ code: 'archive.timed_out' });
  });

  it('holds one parser admission until collaboration has consumed the validated archive', async () => {
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let imports = 0;
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: async () => {
        imports += 1;
        if (imports === 1) {
          firstEntered?.();
          await hold;
        }
        return { ...STAGED_TEMPLATE, templateId: ITEM };
      },
      stageTemplate: () => Promise.resolve(STAGED_TEMPLATE),
      finalizeManaged: () => Promise.resolve(MANAGED_RESULT),
      abortStage: () => Promise.resolve(),
      sweepExpired: () => Promise.resolve(EMPTY_SWEEP),
    };
    const bytes = await archiveBytes();
    const request = {
      method: 'POST' as const,
      url: `/templates/commit?workspaceId=${ITEM}`,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/zip',
        'x-nix-template-digest': createHash('sha256').update(bytes).digest('hex'),
      },
      payload: Buffer.from(bytes),
    };
    const app = track(server({ templates, templateLimit: 1 }));
    const first = app.inject(request);
    await entered;

    const refused = await app.inject(request);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'template.busy' });

    releaseFirst?.();
    expect((await first).statusCode).toBe(201);
    expect(imports).toBe(1);
  });

  it('propagates the request deadline through the collaboration import call', async () => {
    let receivedSignal: AbortSignal | undefined;
    const templates: TemplateImporter = {
      authorizePreview: () => Promise.resolve(IMPORT_AUTHORIZATION),
      validateTemplate: () => Promise.resolve(TEMPLATE_VALIDATION),
      importTemplate: (_token, _request, signal) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'),
              );
            },
            { once: true },
          );
        });
      },
      stageTemplate: () => Promise.resolve(STAGED_TEMPLATE),
      finalizeManaged: () => Promise.resolve(MANAGED_RESULT),
      abortStage: () => Promise.resolve(),
      sweepExpired: () => Promise.resolve(EMPTY_SWEEP),
    };
    const bytes = await archiveBytes();
    const response = await track(server({ templates, templateReadTimeoutMs: 10 })).inject({
      method: 'POST',
      url: `/templates/commit?workspaceId=${ITEM}`,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/zip',
        'x-nix-template-digest': createHash('sha256').update(bytes).digest('hex'),
      },
      payload: Buffer.from(bytes),
    });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(408);
    expect(response.json()).toMatchObject({ code: 'template.timed_out' });
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
