import { readArchive, validateTemplateArchive, writeArchive } from '@nix/export';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { CoreTemplateClient } from './core.ts';
import { prepareTemplateArchive } from './export.ts';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const STATUS = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Open', 'Done'],
  required: false,
} as const;

describe('template archive preparation', () => {
  it('uses portable source ids and the additive template profile in the manifest', async () => {
    const core = exportCore();
    const prepared = await prepareTemplateArchive({
      core,
      pool: emptyPool(),
      token: 'token',
      templateId: TEMPLATE,
      exportedAt: new Date('2026-08-16T12:00:00Z'),
    });

    expect(prepared.manifest).toMatchObject({
      root: SOURCE,
      profile: {
        kind: 'template',
        version: 1,
        key: 'team.project',
        name: 'Team project',
        includeBody: false,
        includeChildren: false,
        initialization: { version: 1, inputs: [], rules: [], references: [] },
      },
      items: [{ id: SOURCE, parentId: null, title: 'Project' }],
      rootEffectiveSchema: {
        properties: [STATUS],
        declared: [STATUS],
        inherit: false,
      },
      omitted: [],
      loss: [],
    });
    expect(JSON.stringify(prepared.manifest)).not.toContain(HIDDEN);

    const chunks: Uint8Array[] = [];
    for await (const chunk of writeArchive(prepared)) chunks.push(chunk);
    // eslint-disable-next-line @typescript-eslint/require-await -- the reader deliberately accepts a streaming source.
    async function* upload(): AsyncGenerator<Uint8Array> {
      yield* chunks;
    }
    const reread = await readArchive(upload());
    validateTemplateArchive(reread);
    expect(reread.bundles[0]?.schema).toEqual({
      properties: [STATUS],
      declared: [STATUS],
      inherit: false,
    });
    expect(reread.bundles[0]?.views).toMatchObject({
      default: 'document',
      views: [{ id: 'list', columns: [], groupOrder: [], filters: [] }],
    });
  });

  it('exports declared file versions and streams their capability bytes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new TextEncoder().encode('abc'), { status: 200 }));
    try {
      const core = exportCore(true);
      const capabilitySpy = vi.spyOn(core, 'getTemplateExportFileCapability');
      const prepared = await prepareTemplateArchive({
        core,
        pool: emptyPool(),
        token: 'token',
        templateId: TEMPLATE,
        exportedAt: new Date('2026-08-16T12:00:00Z'),
      });
      expect(prepared.manifest.formatVersion).toBe(2);
      expect(prepared.manifest.files).toMatchObject([
        { itemId: SOURCE, version: 1, current: true, fileName: 'brief.txt', byteLength: 3 },
      ]);
      expect(JSON.stringify(prepared.manifest)).not.toContain('bucket.test');
      expect(capabilitySpy).not.toHaveBeenCalled();
      const chunks: Uint8Array[] = [];
      for await (const chunk of writeArchive(prepared)) chunks.push(chunk);
      // eslint-disable-next-line @typescript-eslint/require-await -- the reader accepts a streaming source.
      async function* upload(): AsyncGenerator<Uint8Array> {
        yield* chunks;
      }
      const reread = await readArchive(upload());
      expect(reread.files).toHaveLength(1);
      expect(new TextDecoder().decode(reread.files[0]?.bytes)).toBe('abc');
      expect(capabilitySpy).toHaveBeenCalledExactlyOnceWith(
        'token',
        TEMPLATE,
        archiveFile(1, true).fileVersionId,
        1,
        expect.any(AbortSignal),
      );
      const fetchCall = fetchSpy.mock.calls[0];
      expect(fetchCall?.[0]).toBe('https://bucket.test/capability');
      expect(fetchCall?.[1]?.redirect).toBe('error');
      expect(fetchCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('loads bounded history pages at the same revision before writing descriptors', async () => {
    const core = exportCore(true);
    const cursor = '77777777-7777-4777-8777-777777777777';
    const pageSpy = vi.spyOn(core, 'getTemplateExportFiles');
    pageSpy
      .mockResolvedValueOnce({
        revision: 1,
        files: [archiveFile(1, false)],
        nextAfterFileVersionId: cursor,
        complete: false,
      })
      .mockResolvedValueOnce({
        revision: 1,
        files: [archiveFile(2, true)],
        nextAfterFileVersionId: null,
        complete: true,
      });
    const prepared = await prepareTemplateArchive({
      core,
      pool: emptyPool(),
      token: 'token',
      templateId: TEMPLATE,
      exportedAt: new Date('2026-08-16T12:00:00Z'),
    });

    expect(prepared.manifest.files).toMatchObject([
      { itemId: SOURCE, version: 1, current: false },
      { itemId: SOURCE, version: 2, current: true },
    ]);
    expect(pageSpy).toHaveBeenNthCalledWith(1, 'token', TEMPLATE, undefined, undefined);
    expect(pageSpy).toHaveBeenNthCalledWith(2, 'token', TEMPLATE, cursor, 1);
    const capabilitySpy = vi.spyOn(core, 'getTemplateExportFileCapability');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new TextEncoder().encode('abc'), { status: 200 }));
    try {
      const fileIterator = prepared.files[Symbol.asyncIterator]();
      const first = await fileIterator.next();
      if (first.done) throw new Error('The export did not yield its first file.');
      expect(capabilitySpy).toHaveBeenCalledTimes(1);
      expect(capabilitySpy.mock.calls[0]?.[3]).toBe(1);
      const bodyChunks = first.value.chunks[Symbol.asyncIterator]();
      await bodyChunks.next();
      await fileIterator.return();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses redirects and cancels the capability stream when archive consumption stops', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode('a'));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200 }));
    const abort = new AbortController();
    try {
      const prepared = await prepareTemplateArchive({
        core: exportCore(true),
        pool: emptyPool(),
        token: 'token',
        templateId: TEMPLATE,
        exportedAt: new Date('2026-08-16T12:00:00Z'),
        signal: abort.signal,
      });
      const fileSource = await prepared.files.next();
      const chunks = fileSource.value?.chunks[Symbol.asyncIterator]();
      expect(chunks).toBeDefined();
      expect((await chunks?.next())?.done).toBe(false);
      expect(pulls).toBe(1);
      const fetchCall = fetchSpy.mock.calls[0];
      expect(fetchCall?.[0]).toBe('https://bucket.test/capability');
      expect(fetchCall?.[1]?.redirect).toBe('error');
      expect(fetchCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
      abort.abort();
      await expect(chunks?.next()).resolves.toMatchObject({ done: true });
      expect(cancelled).toBe(true);
      expect(pulls).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function exportCore(withFile = false): CoreTemplateClient {
  const unused = () =>
    Promise.reject(new Error('This operation is not part of archive preparation.'));
  return {
    beginCapture: unused,
    beginImport: unused,
    beginApplication: unused,
    authorizeOperationItem: unused,
    finalize: unused,
    abort: unused,
    finalizeManaged: unused,
    sweepExpired: unused,
    authorizeImport: unused,
    beginDraft: unused,
    getDraft: unused,
    patchDraft: unused,
    patchDraftItem: unused,
    saveDraft: unused,
    discardDraft: unused,
    authorizeDraftItem: unused,
    authorizeTemplateItem: () =>
      Promise.resolve({
        templateId: TEMPLATE,
        sourceId: SOURCE,
        itemId: HIDDEN,
        tenantId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        workspaceId: WORKSPACE,
        itemType: 'note',
        canRead: true,
        canWrite: true,
      }),
    getTemplateExport: () =>
      Promise.resolve({
        templateId: TEMPLATE,
        workspaceId: WORKSPACE,
        stableKey: 'team.project',
        title: 'Team project',
        description: 'A starting point.',
        origin: 'user',
        revision: 1,
        includeBody: false,
        includeChildren: false,
        initialization: { version: 1, inputs: [], rules: [], references: [] },
        items: [
          {
            sourceId: SOURCE,
            parentSourceId: null,
            itemId: HIDDEN,
            itemType: withFile ? 'file' : 'note',
            title: 'Project',
            seq: '1',
            properties: {},
            // Core's internal route returns the stored declaration, not an archive SchemaSnapshot.
            schema: { properties: [STATUS], inherit: false },
            views: {
              default: 'document',
              views: [
                {
                  id: 'list',
                  name: 'List',
                  kind: 'list',
                  columns: [],
                  groupBy: null,
                  groupOrder: [],
                  dateProperty: null,
                  sortBy: null,
                  sortDescending: false,
                  mode: null,
                  coverProperty: null,
                  endDateProperty: null,
                  cardSize: null,
                  filters: [],
                  companionViewId: null,
                  companionPlacement: null,
                  interactiveForm: null,
                },
              ],
            },
            hasBody: false,
            recurrence: null,
          },
        ],
      }),
    getTemplateExportFiles: () =>
      Promise.resolve({
        revision: 1,
        files: withFile
          ? [
              {
                sourceId: SOURCE,
                fileVersionId: archiveFile(1, true).fileVersionId,
                version: 1,
                current: true,
                fileName: 'brief.txt',
                mediaType: 'text/plain',
                byteLength: 3,
                sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
                previewable: false,
                pixelWidth: null,
                pixelHeight: null,
              },
            ]
          : [],
        nextAfterFileVersionId: null,
        complete: true,
      }),
    getTemplateExportFileCapability: () =>
      Promise.resolve({
        downloadUrl: 'https://bucket.test/capability',
        expiresAt: '2026-08-16T13:00:00Z',
      }),
  };
}

function archiveFile(version: number, current: boolean) {
  return {
    fileVersionId:
      version === 1
        ? '88888888-8888-4888-8888-888888888888'
        : '99999999-9999-4999-8999-999999999999',
    sourceId: SOURCE,
    version,
    current,
    fileName: 'brief.txt',
    mediaType: 'text/plain',
    byteLength: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    previewable: false,
    pixelWidth: null,
    pixelHeight: null,
  };
}

function emptyPool(): Pool {
  const client = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}
