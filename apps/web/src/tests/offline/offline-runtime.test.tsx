import 'fake-indexeddb/auto';
import {
  createNixClient,
  itemSchema,
  NixApiError,
  type Item,
  type NixClient,
  type Workspace,
} from '@nix/api-client';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';

import { ApiClientOverrideProvider } from '../../api/api-client-provider';
import { AuthProvider } from '../../auth/auth-provider';
import { useSessionStore } from '../../auth/session-store';
import {
  clearBodyCache,
  discardBodyCache,
  documentScope,
  openBodyCache,
  readBodyCache,
  writeBodyCache,
} from '../../editor/body-cache';
import type * as CollabSyncModule from '../../editor/collab-sync';
import type * as DraftJournalModule from '../../editor/draft-journal';
import type { synchronizeOfflineBody } from '../../offline/offline-body';
import {
  OfflineRuntime,
  requestOfflineSync,
  synchronizeOfflineNotes,
} from '../../offline/offline-runtime';
import {
  clearOfflineData,
  createOfflineNote,
  forgetOfflineAccount,
  getOfflineSnapshot,
  rememberOfflineAccount,
  renameOfflineNote,
  saveOfflineNote,
  saveOfflineWorkspaces,
  subscribeOfflineNotes,
  type OfflineNote,
} from '../../offline/offline-store';
import { item, STUB_WORKSPACE } from '../api-stub';

const transport = vi.hoisted(
  (): {
    downloaded: string[];
    readOnly: Set<string>;
    failures: Map<string, Error>;
    drafts: Set<string>;
    migrations: { from: string; to: string }[];
    migrationFailure: boolean;
    beforeFlush: ((scope: string) => Promise<void>) | undefined;
    beforeAccountFlush: ((subject: string) => Promise<void>) | undefined;
    beforeBodySave: (() => Promise<void>) | undefined;
    assetFailure: Error | undefined;
  } => ({
    downloaded: [],
    readOnly: new Set<string>(),
    failures: new Map<string, Error>(),
    drafts: new Set<string>(),
    migrations: [],
    migrationFailure: false,
    beforeFlush: undefined,
    beforeAccountFlush: undefined,
    beforeBodySave: undefined,
    assetFailure: undefined,
  }),
);

vi.mock('../../editor/collab-sync', async (original) => ({
  ...(await original<typeof CollabSyncModule>()),
  flushLocalDraftsForScope: (scope: string) => transport.beforeFlush?.(scope) ?? Promise.resolve(),
  flushLocalDraftsForAccount: (subject: string) =>
    transport.beforeAccountFlush?.(subject) ?? Promise.resolve(),
}));

vi.mock('../../offline/offline-body', () => ({
  async synchronizeOfflineBody(
    options: Parameters<typeof synchronizeOfflineBody>[0],
  ): Promise<{ docId: string; canWrite: boolean }> {
    options.signal.throwIfAborted();
    transport.downloaded.push(options.itemId);
    const canWrite = !transport.readOnly.has(options.itemId);
    if (!canWrite) await options.onReadOnly?.();
    const failure = transport.failures.get(options.itemId);
    if (failure !== undefined) throw failure;
    await transport.beforeBodySave?.();
    const cacheScope = documentScope(options.subject, options.workspaceId, options.itemId, 'note');
    if (cacheScope === undefined) throw new Error('A download needs a cache scope.');
    options.doc.getText('test-body').insert(0, `Downloaded ${options.itemId}`);
    const docId = `document:${options.itemId}`;
    await writeBodyCache({
      scope: cacheScope,
      docId,
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      update: Y.encodeStateAsUpdate(options.doc),
    });
    return { docId, canWrite };
  },
}));

vi.mock('../../editor/draft-journal', async (original) => ({
  ...(await original<typeof DraftJournalModule>()),
  listDraftScopes: () => Promise.resolve([...transport.drafts]),
  async migrateLocalDrafts(from: string, to: string): Promise<void> {
    transport.migrations.push({ from, to });
    if (transport.migrationFailure) throw new Error('Migration interrupted');
    const cached = await readBodyCache(from);
    if (cached !== null) {
      const [, , id] = z.array(z.string()).parse(JSON.parse(to));
      await writeBodyCache({ ...cached, scope: to, docId: `local:${id ?? ''}` });
      await discardBodyCache(from);
    }
  },
}));

vi.mock('../../offline/offline-assets', () => ({
  cacheOfflineNoteAssets: () =>
    transport.assetFailure === undefined
      ? Promise.resolve()
      : Promise.reject(transport.assetFailure),
}));

const SUBJECT = 'offline-person';
const OTHER_SUBJECT = 'another-person';
const WORKSPACE = STUB_WORKSPACE satisfies Workspace;
const createSchema = z.object({
  type: z.literal('note'),
  title: z.string(),
  parentId: z.string().nullable(),
  idempotencyKey: z.uuid(),
});
type Creation = z.infer<typeof createSchema>;

function uuid(sequence: number): string {
  return `a0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}
function note(sequence: number, patch: Partial<Item> = {}): Item {
  return itemSchema.parse({
    ...item({ id: uuid(sequence), title: `Note ${String(sequence)}` }),
    ...patch,
  });
}
function scope(id: string, subject = SUBJECT, workspaceId = WORKSPACE.id): string {
  const result = documentScope(subject, workspaceId, id, 'note');
  if (result === undefined) throw new Error('Missing scope');
  return result;
}
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  });
}
function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(init.body);
}

function core(
  initialItems: readonly Item[],
  options: {
    workspaces?: readonly Workspace[];
    locked?: ReadonlySet<string>;
    lockRefusals?: ReadonlyMap<string, number>;
    failParent?: string;
    failRootSecondPage?: boolean;
    refuseCreateTitles?: ReadonlySet<string>;
    onCreate?: (input: Creation) => Promise<void>;
    onRename?: (id: string, title: string) => Promise<void>;
    renameRefusal?: { status: number; code?: string };
  } = {},
): {
  client: NixClient;
  creations: Creation[];
  renamed: { id: string; title: string }[];
  requests: URL[];
} {
  const serverItems = [...initialItems];
  const creations: Creation[] = [];
  const renamed: { id: string; title: string }[] = [];
  const requests: URL[] = [];
  const receipts = new Map<string, Item>();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push(url);
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/v1/workspaces') {
      const workspaces = options.workspaces ?? [WORKSPACE];
      const offset = url.searchParams.has('cursor') ? 1 : 0;
      return json({
        items: workspaces.slice(offset, offset + 1),
        nextCursor: offset + 1 < workspaces.length ? String(offset + 1) : null,
      });
    }
    const workspaceItems = /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/items$/u.exec(url.pathname);
    if (workspaceItems !== null && method === 'GET') {
      const parent = url.searchParams.get('parentId');
      if (
        (options.failParent !== undefined && parent === options.failParent) ||
        (options.failRootSecondPage === true && parent === null && url.searchParams.has('cursor'))
      )
        throw new TypeError('Connection lost during traversal');
      const matches = serverItems
        .filter(
          (candidate) =>
            candidate.workspaceId === workspaceItems[1] && candidate.parentId === parent,
        )
        .map((candidate) => ({
          ...candidate,
          hasChildren:
            candidate.hasChildren || serverItems.some((child) => child.parentId === candidate.id),
        }));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 200);
      return json({
        items: matches.slice(offset, offset + pageSize),
        nextCursor: offset + pageSize < matches.length ? String(offset + pageSize) : null,
      });
    }
    if (workspaceItems !== null && method === 'POST') {
      const creation = createSchema.parse(requestBody(init));
      creations.push(creation);
      if (options.refuseCreateTitles?.has(creation.title)) return json({}, 403);
      let created = receipts.get(creation.idempotencyKey);
      if (created === undefined) {
        created = note(10_000 + receipts.size, {
          workspaceId: workspaceItems[1] ?? WORKSPACE.id,
          title: creation.title,
          parentId: creation.parentId,
        });
        receipts.set(creation.idempotencyKey, created);
        serverItems.push(created);
      }
      await options.onCreate?.(creation);
      return json(created, 201);
    }
    const lock = /^\/api\/v1\/items\/([0-9a-f-]+)\/lock$/u.exec(url.pathname);
    if (lock !== null) {
      const refusal = options.lockRefusals?.get(lock[1] ?? '');
      if (refusal !== undefined) return json({}, refusal);
      return json({
        locked: options.locked?.has(lock[1] ?? '') ?? false,
        unlockedUntil: null,
        lockItemId: null,
        selfLocked: false,
      });
    }
    const rename = /^\/api\/v1\/items\/([0-9a-f-]+)$/u.exec(url.pathname);
    if (rename !== null && method === 'PATCH') {
      const title = z.object({ title: z.string() }).parse(requestBody(init)).title;
      const id = rename[1] ?? '';
      renamed.push({ id, title });
      if (options.renameRefusal !== undefined)
        return json(
          options.renameRefusal.code === undefined
            ? {}
            : { status: options.renameRefusal.status, code: options.renameRefusal.code },
          options.renameRefusal.status,
          options.renameRefusal.code === undefined
            ? 'application/json'
            : 'application/problem+json',
        );
      await options.onRename?.(id, title);
      const index = serverItems.findIndex((candidate) => candidate.id === id);
      const previous = serverItems[index];
      if (previous === undefined) return json({}, 404);
      const updated = { ...previous, title };
      serverItems[index] = updated;
      return json(updated);
    }
    throw new Error(`Unexpected Core request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetch);
  const client = createNixClient({
    baseUrl: 'http://offline.test',
    tokens: {
      getAccessToken: () => Promise.resolve('test-token'),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  return { client, creations, renamed, requests };
}
function synchronize(client: NixClient, signal = new AbortController().signal): Promise<void> {
  return synchronizeOfflineNotes({
    client,
    subject: SUBJECT,
    getAccessToken: () => Promise.resolve('test-token'),
    signal,
  });
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function nextReady(): Promise<void> {
  return new Promise<void>((resolve) => {
    let active = getOfflineSnapshot().status !== 'ready';
    const unsubscribe = subscribeOfflineNotes(() => {
      if (getOfflineSnapshot().status !== 'ready') {
        active = true;
        return;
      }
      if (!active) return;
      unsubscribe();
      resolve();
    });
  });
}
function renderRuntime(client: NixClient): ReturnType<typeof render> {
  useSessionStore.setState({
    status: 'authenticated',
    profile: { subject: SUBJECT, name: 'Offline person', email: null },
    error: null,
  });
  return render(
    <AuthProvider>
      <ApiClientOverrideProvider client={client}>
        <OfflineRuntime />
      </ApiClientOverrideProvider>
    </AuthProvider>,
  );
}
async function saved(serverNote: Item, patch: Partial<OfflineNote> = {}): Promise<OfflineNote> {
  const stored: OfflineNote = {
    id: serverNote.id,
    workspaceId: serverNote.workspaceId,
    parentId: serverNote.parentId,
    title: serverNote.title,
    canWrite: true,
    bodyAvailable: true,
    publication: { kind: 'published', serverId: serverNote.id, docId: `document:${serverNote.id}` },
    pendingTitle: null,
    blockedReason: null,
    ...patch,
  };
  const doc = new Y.Doc();
  await writeBodyCache({
    scope: scope(serverNote.id, SUBJECT, serverNote.workspaceId),
    docId: `document:${serverNote.id}`,
    schemaVersion: SCHEMA_VERSION,
    savedAt: Date.now(),
    update: Y.encodeStateAsUpdate(doc),
  });
  doc.destroy();
  await saveOfflineNote(stored);
  return stored;
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', storage());
  transport.downloaded.length = 0;
  transport.readOnly.clear();
  transport.failures.clear();
  transport.drafts.clear();
  transport.migrations.length = 0;
  transport.migrationFailure = false;
  transport.beforeFlush = undefined;
  transport.beforeAccountFlush = undefined;
  transport.beforeBodySave = undefined;
  transport.assetFailure = undefined;
  await clearOfflineData();
  await clearBodyCache();
  await openBodyCache(SUBJECT);
  await rememberOfflineAccount({ subject: SUBJECT, name: 'Offline person', email: null });
  await saveOfflineWorkspaces([WORKSPACE]);
});

describe('scheduling background offline synchronization', () => {
  it('does not queue another full pass for repeated online events during an active pass', async () => {
    const remoteNote = note(1);
    const remote = core([remoteNote]);
    const flushStarted = deferred();
    const releaseFlush = deferred();
    let flushes = 0;
    transport.beforeAccountFlush = async () => {
      flushes += 1;
      if (flushes === 1) {
        flushStarted.resolve();
        await releaseFlush.promise;
      }
    };
    const mounted = renderRuntime(remote.client);
    await flushStarted.promise;
    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    const ready = nextReady();
    await act(async () => {
      releaseFlush.resolve();
      await ready;
    });

    expect(flushes).toBe(1);
    expect(transport.downloaded).toEqual([remoteNote.id]);
    mounted.unmount();
  });

  it('retries when its web lock is still held by a pass that the effect restart aborted', async () => {
    let held = false;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          grant: (lock: unknown) => Promise<void>,
        ) => {
          if (held) {
            await grant(null);
            return;
          }
          held = true;
          try {
            await grant({});
          } finally {
            held = false;
          }
        },
      },
    });
    try {
      const remoteNote = note(1);
      const first = core([remoteNote]);
      const flushStarted = deferred();
      const releaseFlush = deferred();
      let flushes = 0;
      transport.beforeAccountFlush = async () => {
        flushes += 1;
        if (flushes === 1) {
          flushStarted.resolve();
          await releaseFlush.promise;
        }
      };
      const mounted = renderRuntime(first.client);
      await flushStarted.promise;
      // A new client restarts the effect: the aborted pass still holds the lock when the new one asks.
      mounted.rerender(
        <AuthProvider>
          <ApiClientOverrideProvider client={core([remoteNote]).client}>
            <OfflineRuntime />
          </ApiClientOverrideProvider>
        </AuthProvider>,
      );
      const ready = nextReady();
      await act(async () => {
        releaseFlush.resolve();
        await ready;
      });

      expect(transport.downloaded).toEqual([remoteNote.id]);
      mounted.unmount();
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('retries an aborted active pass when the network returns before its cleanup finishes', async () => {
    const remoteNote = note(1);
    const remote = core([remoteNote]);
    const flushStarted = deferred();
    const releaseFlush = deferred();
    let flushes = 0;
    transport.beforeAccountFlush = async () => {
      flushes += 1;
      if (flushes === 1) {
        flushStarted.resolve();
        await releaseFlush.promise;
      }
    };
    const mounted = renderRuntime(remote.client);
    await flushStarted.promise;
    act(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    const ready = nextReady();
    await act(async () => {
      releaseFlush.resolve();
      await ready;
    });

    expect(flushes).toBe(2);
    expect(transport.downloaded).toEqual([remoteNote.id]);
    expect(getOfflineSnapshot().status).toBe('ready');
    mounted.unmount();
  });

  it('waits five minutes after a long pass completes before starting the next automatic pass', async () => {
    const remoteNote = note(1);
    const remote = core([remoteNote]);
    const flushStarted = deferred();
    const releaseFlush = deferred();
    let flushes = 0;
    transport.beforeAccountFlush = async () => {
      flushes += 1;
      if (flushes === 1) {
        flushStarted.resolve();
        await releaseFlush.promise;
      }
    };
    const mounted = renderRuntime(remote.client);
    await flushStarted.promise;
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });

    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));
    expect(transport.downloaded).toEqual([]);
    const firstReady = nextReady();
    await act(async () => {
      releaseFlush.resolve();
      await firstReady;
    });
    expect(getOfflineSnapshot().status).toBe('ready');
    expect(transport.downloaded).toEqual([remoteNote.id]);

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 - 1));
    expect(getOfflineSnapshot().status).toBe('ready');
    expect(transport.downloaded).toEqual([remoteNote.id]);
    const secondReady = nextReady();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await secondReady;
    });
    expect(transport.downloaded).toEqual([remoteNote.id, remoteNote.id]);

    mounted.unmount();
    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));
    expect(transport.downloaded).toEqual([remoteNote.id, remoteNote.id]);
  });

  it('coalesces manual and online requests during an active pass into one immediate follow-up', async () => {
    const remoteNote = note(1);
    const remote = core([remoteNote]);
    const flushStarted = deferred();
    const releaseFlush = deferred();
    let flushes = 0;
    transport.beforeAccountFlush = async () => {
      flushes += 1;
      if (flushes === 1) {
        flushStarted.resolve();
        await releaseFlush.promise;
      }
    };
    const mounted = renderRuntime(remote.client);
    await flushStarted.promise;
    act(() => {
      requestOfflineSync();
      window.dispatchEvent(new Event('online'));
    });
    const followUpReady = new Promise<void>((resolve) => {
      let completed = 0;
      let previous = getOfflineSnapshot().status;
      const unsubscribe = subscribeOfflineNotes(() => {
        const current = getOfflineSnapshot().status;
        const finished = current === 'ready' && previous !== 'ready';
        previous = current;
        if (!finished) return;
        completed += 1;
        if (completed !== 2) return;
        unsubscribe();
        resolve();
      });
    });

    await act(async () => {
      releaseFlush.resolve();
      await followUpReady;
    });

    expect(transport.downloaded).toEqual([remoteNote.id, remoteNote.id]);
    expect(getOfflineSnapshot().status).toBe('ready');
    mounted.unmount();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('synchronizing the offline note collection', () => {
  it('flushes and prioritizes authorized pending edits and their ancestors before ordinary downloads', async () => {
    const clean = note(1);
    const otherClean = note(2);
    const parent = note(3);
    const canvas = note(4, { type: 'canvas', parentId: parent.id });
    const buffered = note(5, { parentId: canvas.id });
    const titled = note(6);
    const secondWorkspace = { ...WORKSPACE, id: uuid(20_000), name: 'Other workspace' };
    const moved = note(7, { workspaceId: secondWorkspace.id });
    await saved(buffered);
    await saved(titled, { pendingTitle: 'Offline title' });
    transport.drafts.add(scope(moved.id));
    transport.drafts.add(scope(uuid(99)));
    const remote = core([clean, otherClean, parent, canvas, buffered, titled, moved], {
      workspaces: [WORKSPACE, secondWorkspace],
    });
    transport.beforeAccountFlush = (subject) => {
      expect(subject).toBe(SUBJECT);
      expect(remote.requests.filter((request) => request.pathname.endsWith('/lock'))).toHaveLength(
        7,
      );
      expect(transport.downloaded).toEqual([]);
      transport.drafts.add(scope(buffered.id));
      return Promise.resolve();
    };

    await synchronize(remote.client);

    expect(transport.downloaded).toEqual([
      parent.id,
      titled.id,
      buffered.id,
      clean.id,
      otherClean.id,
      moved.id,
    ]);
    expect(remote.renamed).toEqual([{ id: titled.id, title: 'Offline title' }]);
  });

  it('stops before downloading when buffered edits cannot be durably flushed for priority', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    const remote = core([remoteNote]);
    transport.beforeAccountFlush = () => Promise.reject(new Error('Device storage is full'));

    await expect(synchronize(remote.client)).rejects.toThrow('Device storage is full');

    expect(transport.downloaded).toEqual([]);
    expect(await readBodyCache(scope(remoteNote.id))).not.toBeNull();
    expect(getOfflineSnapshot().notes[0]).toMatchObject({ bodyAvailable: true, canWrite: true });
  });

  it('downloads every page and unopened descendant across all accessible workspaces', async () => {
    const roots = Array.from({ length: 201 }, (_, index) => note(index + 1));
    const canvas = note(300, { type: 'canvas', hasChildren: true });
    const nested = note(301, { parentId: canvas.id, type: 'custom-prose' });
    const sheet = note(302, { type: 'spreadsheet' });
    const file = note(303, { type: 'file' });
    const locked = note(304, { hasChildren: true });
    const concealed = note(305, { parentId: locked.id });
    const secondWorkspace = { ...WORKSPACE, id: uuid(20_000), name: 'Other workspace' };
    const elsewhere = note(306, { workspaceId: secondWorkspace.id });
    const remote = core([...roots, canvas, nested, sheet, file, locked, concealed, elsewhere], {
      workspaces: [WORKSPACE, secondWorkspace],
      locked: new Set([locked.id]),
    });

    await synchronize(remote.client);

    const snapshot = getOfflineSnapshot();
    expect(snapshot.status).toBe('ready');
    expect(snapshot.notes).toHaveLength(203);
    expect(snapshot.notes.every((candidate) => candidate.bodyAvailable)).toBe(true);
    expect(snapshot.workspaces.map((workspace) => workspace.id)).toEqual([
      WORKSPACE.id,
      secondWorkspace.id,
    ]);
    expect(snapshot.completed).toBe(203);
    expect(snapshot.total).toBe(203);
    expect(snapshot.pending).toBe(0);
    expect(transport.downloaded).toContain(nested.id);
    expect(transport.downloaded).toContain(elsewhere.id);
    expect(transport.downloaded).not.toContain(canvas.id);
    expect(transport.downloaded).not.toContain(sheet.id);
    expect(transport.downloaded).not.toContain(file.id);
    expect(transport.downloaded).not.toContain(locked.id);
    expect(transport.downloaded).not.toContain(concealed.id);
    expect(
      remote.requests.some(
        (request) => request.searchParams.has('cursor') && request.pathname.endsWith('/items'),
      ),
    ).toBe(true);
    expect(await readBodyCache(scope(roots[0]?.id ?? ''))).not.toBeNull();
  });

  it('keeps old metadata and bodies when traversal fails after the first page', async () => {
    const old = note(500);
    await saved(old);
    const remote = core(
      Array.from({ length: 201 }, (_, index) => note(index + 1)),
      { failRootSecondPage: true },
    );

    await expect(synchronize(remote.client)).rejects.toThrow();

    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === old.id)?.bodyAvailable,
    ).toBe(true);
    expect(await readBodyCache(scope(old.id))).not.toBeNull();
    expect(transport.downloaded).toEqual([]);
  });

  it('keeps the collection when an unopened child traversal fails', async () => {
    const old = note(500);
    await saved(old);
    const parent = note(501, { hasChildren: true });
    const remote = core([parent], { failParent: parent.id });

    await expect(synchronize(remote.client)).rejects.toThrow();

    expect(getOfflineSnapshot().notes.map((candidate) => candidate.id)).toEqual([old.id]);
    expect(await readBodyCache(scope(old.id))).not.toBeNull();
  });

  it('seals inherited locked copies even when a later workspace traversal fails', async () => {
    const lockedParent = note(500, { hasChildren: true });
    const interveningCanvas = note(501, {
      type: 'canvas',
      parentId: lockedParent.id,
      hasChildren: true,
    });
    const lockedDescendant = note(502, { parentId: interveningCanvas.id });
    await saved(lockedParent);
    await saved(lockedDescendant);
    transport.drafts.add(scope(lockedDescendant.id));
    const anotherWorkspace = { ...WORKSPACE, id: uuid(20_000), name: 'Another workspace' };
    const failingParent = note(503, { workspaceId: anotherWorkspace.id, hasChildren: true });
    const remote = core([lockedParent, interveningCanvas, lockedDescendant, failingParent], {
      workspaces: [WORKSPACE, anotherWorkspace],
      locked: new Set([lockedParent.id, lockedDescendant.id]),
      failParent: failingParent.id,
    });

    await expect(synchronize(remote.client)).rejects.toThrow();

    expect(await readBodyCache(scope(lockedParent.id))).toBeNull();
    expect(await readBodyCache(scope(lockedDescendant.id))).toBeNull();
    expect(transport.drafts).toContain(scope(lockedDescendant.id));
  });

  it.each([403, 404, 410, 423])(
    'seals a cached subtree refused with %s during its lock check and downloads safe siblings',
    async (status) => {
      const parent = note(500, { hasChildren: true });
      const child = note(501, { parentId: parent.id });
      const safe = note(502);
      await saved(parent);
      await saved(child);
      transport.drafts.add(scope(child.id));
      const remote = core([parent, child, safe], {
        lockRefusals: new Map([
          [parent.id, status],
          [child.id, status],
        ]),
      });

      await synchronize(remote.client);

      expect(getOfflineSnapshot()).toMatchObject({ status: 'error', completed: 1, total: 1 });
      expect(transport.downloaded).toEqual([safe.id]);
      expect(
        remote.requests.some((request) => request.searchParams.get('parentId') === parent.id),
      ).toBe(false);
      expect(await readBodyCache(scope(parent.id))).toBeNull();
      expect(await readBodyCache(scope(child.id))).toBeNull();
      expect(await readBodyCache(scope(safe.id))).not.toBeNull();
      expect(
        getOfflineSnapshot().notes.find((candidate) => candidate.id === child.id),
      ).toMatchObject({
        bodyAvailable: false,
        canWrite: false,
      });
      expect(transport.drafts).toContain(scope(child.id));
    },
  );

  it('reports partial body downloads without claiming all notes are ready', async () => {
    const first = note(1);
    const second = note(2);
    transport.failures.set(second.id, new Error('Device storage is full'));
    const remote = core([first, second]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot()).toMatchObject({
      status: 'error',
      completed: 1,
      total: 2,
      lastSyncedAt: null,
    });
    expect(getOfflineSnapshot().error).toContain('Device storage is full');
    expect(getOfflineSnapshot().notes.map((candidate) => candidate.id)).toEqual([first.id]);
  });

  it('downloads a read-only note and keeps offline editing disabled', async () => {
    const remoteNote = note(1);
    transport.readOnly.add(remoteNote.id);
    const remote = core([remoteNote]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot().notes[0]).toMatchObject({ bodyAvailable: true, canWrite: false });
    await expect(renameOfflineNote(remoteNote.id, 'Forbidden change')).rejects.toThrow(
      'cannot be changed',
    );
    expect(getOfflineSnapshot().notes[0]?.title).toBe(remoteNote.title);
  });

  it('persists a read-only downgrade when pending body edits cannot be synchronized', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    transport.drafts.add(scope(remoteNote.id));
    transport.readOnly.add(remoteNote.id);
    transport.failures.set(remoteNote.id, new Error('Pending edits need write access'));
    const remote = core([remoteNote]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot()).toMatchObject({ status: 'error', pending: 1 });
    expect(getOfflineSnapshot().notes[0]).toMatchObject({ bodyAvailable: true, canWrite: false });
    expect(await readBodyCache(scope(remoteNote.id))).not.toBeNull();
    expect(transport.drafts).toContain(scope(remoteNote.id));
    await expect(renameOfflineNote(remoteNote.id, 'Forbidden change')).rejects.toThrow(
      'cannot be changed',
    );
  });

  it('keeps a readable note body and reports an attachment download failure', async () => {
    const remoteNote = note(1);
    transport.assetFailure = new Error('An embedded image could not be downloaded');
    const remote = core([remoteNote]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot()).toMatchObject({
      status: 'error',
      completed: 1,
      total: 1,
      lastSyncedAt: null,
    });
    expect(getOfflineSnapshot().error).toContain('embedded image');
    expect(getOfflineSnapshot().notes[0]).toMatchObject({ id: remoteNote.id, bodyAvailable: true });
    expect(await readBodyCache(scope(remoteNote.id))).not.toBeNull();
  });

  it('preserves a newer title queued while the server acknowledges an earlier rename', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    await renameOfflineNote(remoteNote.id, 'Earlier title');
    const remote = core([remoteNote], {
      onRename: async () => {
        await renameOfflineNote(remoteNote.id, 'Later title');
      },
    });

    await synchronize(remote.client);

    expect(remote.renamed).toEqual([{ id: remoteNote.id, title: 'Earlier title' }]);
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      title: 'Later title',
      pendingTitle: 'Later title',
    });
    expect(getOfflineSnapshot().pending).toBe(1);
  });

  it('keeps a read-authorized body and queued title when its rename is refused', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    await renameOfflineNote(remoteNote.id, 'Desired title');
    const remote = core([remoteNote], { renameRefusal: { status: 403 } });

    await synchronize(remote.client);

    expect(getOfflineSnapshot()).toMatchObject({ status: 'error', pending: 1, completed: 1 });
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      title: 'Desired title',
      pendingTitle: 'Desired title',
      bodyAvailable: true,
      canWrite: false,
    });
    expect(getOfflineSnapshot().notes[0]?.blockedReason).toContain('queued change');
    expect(transport.downloaded).toEqual([remoteNote.id]);
    expect(await readBodyCache(scope(remoteNote.id))).not.toBeNull();
  });

  it.each([
    { status: 423, code: 'items.locked' },
    { status: 403, code: 'body_locked' },
  ])('seals a known title lock refusal and skips its body: $status $code', async (refusal) => {
    const remoteNote = note(1);
    await saved(remoteNote);
    await renameOfflineNote(remoteNote.id, 'Desired title');
    const remote = core([remoteNote], { renameRefusal: refusal });

    await synchronize(remote.client);

    expect(getOfflineSnapshot()).toMatchObject({ status: 'error', pending: 1, completed: 0 });
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      pendingTitle: 'Desired title',
      bodyAvailable: false,
      canWrite: false,
    });
    expect(transport.downloaded).toEqual([]);
    expect(await readBodyCache(scope(remoteNote.id))).toBeNull();
  });

  it.each([{ status: 401 }, { status: 403, code: 'auth.principal_inactive' }])(
    'stops downloads after a global session refusal during a rename: $status $code',
    async (refusal) => {
      const remoteNote = note(1);
      await saved(remoteNote);
      await renameOfflineNote(remoteNote.id, 'Desired title');
      const remote = core([remoteNote, note(2)], {
        renameRefusal: {
          status: refusal.status,
          ...(refusal.code === undefined ? {} : { code: refusal.code }),
        },
      });

      await expect(synchronize(remote.client)).rejects.toThrow();

      expect(transport.downloaded).toEqual([]);
      expect(getOfflineSnapshot().notes[0]).toMatchObject({ pendingTitle: 'Desired title' });
    },
  );

  it('retries a lost creation response with the same key and original input', async () => {
    const local = await createOfflineNote(WORKSPACE.id, null, 'Original title');
    await renameOfflineNote(local.id, 'Edited title');
    let lostResponse = true;
    const remote = core([], {
      onCreate: () => {
        if (lostResponse) {
          lostResponse = false;
          return Promise.reject(new TypeError('Creation response lost'));
        }
        return Promise.resolve();
      },
    });

    await expect(synchronize(remote.client)).rejects.toThrow();
    expect(getOfflineSnapshot().notes[0]?.publication.kind).toBe('pending');
    expect(await readBodyCache(scope(local.id))).not.toBeNull();
    await synchronize(remote.client);

    expect(remote.creations).toHaveLength(2);
    expect(remote.creations[0]).toEqual(remote.creations[1]);
    expect(remote.creations[0]?.title).toBe('Original title');
    expect(remote.renamed).toEqual([{ id: uuid(10_000), title: 'Edited title' }]);
    expect(getOfflineSnapshot().notes).toHaveLength(1);
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: local.id,
      publication: { kind: 'published', serverId: uuid(10_000) },
      title: 'Edited title',
      pendingTitle: null,
    });
  });

  it('resumes a durably recorded creation receipt after interrupted migration', async () => {
    const local = await createOfflineNote(WORKSPACE.id, null, 'Recover after restart');
    transport.migrationFailure = true;
    const remote = core([]);

    await expect(synchronize(remote.client)).rejects.toThrow('Migration interrupted');
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: local.id,
      publication: { kind: 'publishing', serverId: uuid(10_000) },
    });
    expect(await readBodyCache(scope(local.id))).not.toBeNull();
    transport.migrationFailure = false;
    await synchronize(remote.client);

    expect(remote.creations).toHaveLength(1);
    expect(transport.migrations).toHaveLength(2);
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: local.id,
      publication: { kind: 'published' },
      bodyAvailable: true,
      blockedReason: null,
    });
  });

  it('transfers a title queued on an already downloaded creation destination', async () => {
    const local = await createOfflineNote(WORKSPACE.id, null, 'Original title');
    let lostResponse = true;
    const remote = core([], {
      onCreate: () => {
        if (lostResponse) {
          lostResponse = false;
          return Promise.reject(new TypeError('Creation response lost'));
        }
        return Promise.resolve();
      },
    });
    await expect(synchronize(remote.client)).rejects.toThrow();
    const destination = note(10_000, { title: 'Original title' });
    await saved(destination, {
      title: 'Title edited in another tab',
      pendingTitle: 'Title edited in another tab',
    });

    await synchronize(remote.client);

    expect(getOfflineSnapshot().notes).toHaveLength(1);
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: local.id,
      title: 'Title edited in another tab',
      pendingTitle: null,
      publication: { kind: 'published', serverId: destination.id },
    });
    expect(remote.renamed).toEqual([{ id: destination.id, title: 'Title edited in another tab' }]);
    expect(await readBodyCache(scope(destination.id))).not.toBeNull();
  });

  it('preserves a conflicting destination title for recovery without discarding the active body', async () => {
    const local = await createOfflineNote(WORKSPACE.id, null, 'Original title');
    await renameOfflineNote(local.id, 'Local desired title');
    let lostResponse = true;
    const remote = core([], {
      onCreate: () => {
        if (lostResponse) {
          lostResponse = false;
          return Promise.reject(new TypeError('Creation response lost'));
        }
        return Promise.resolve();
      },
    });
    await expect(synchronize(remote.client)).rejects.toThrow();
    const destination = note(10_000, { title: 'Original title' });
    await saved(destination, { title: 'Other desired title', pendingTitle: 'Other desired title' });

    await synchronize(remote.client);
    await synchronize(remote.client);

    const primary = getOfflineSnapshot().notes.find((candidate) => candidate.id === local.id);
    const recovery = getOfflineSnapshot().notes.find(
      (candidate) => candidate.id === destination.id,
    );
    expect(primary).toMatchObject({
      title: 'Local desired title',
      pendingTitle: null,
      bodyAvailable: true,
      blockedReason: null,
    });
    expect(recovery).toMatchObject({
      title: 'Other desired title',
      pendingTitle: 'Other desired title',
      bodyAvailable: false,
      canWrite: false,
    });
    expect(recovery?.blockedReason).toContain('conflict');
    expect(remote.renamed).toEqual([{ id: destination.id, title: 'Local desired title' }]);
    expect(await readBodyCache(scope(destination.id))).not.toBeNull();
  });

  it('publishes nested new notes using the parent server ID', async () => {
    const parent = await createOfflineNote(WORKSPACE.id, null, 'Local parent');
    await createOfflineNote(WORKSPACE.id, parent.id, 'Local child');
    const remote = core([]);

    await synchronize(remote.client);

    expect(
      remote.creations.map((creation) => ({ title: creation.title, parentId: creation.parentId })),
    ).toEqual([
      { title: 'Local parent', parentId: null },
      { title: 'Local child', parentId: uuid(10_000) },
    ]);
    expect(getOfflineSnapshot().notes).toHaveLength(2);
    expect(
      getOfflineSnapshot().notes.every((candidate) => candidate.publication.kind === 'published'),
    ).toBe(true);
  });

  it('continues independent notes when a new parent note is refused', async () => {
    const refused = await createOfflineNote(WORKSPACE.id, null, 'Refused parent');
    const child = await createOfflineNote(WORKSPACE.id, refused.id, 'Dependent child');
    const independent = await createOfflineNote(WORKSPACE.id, null, 'Independent new note');
    const existing = note(1);
    await saved(existing);
    const remote = core([existing], { refuseCreateTitles: new Set(['Refused parent']) });

    await synchronize(remote.client);

    expect(getOfflineSnapshot().status).toBe('error');
    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === refused.id)?.publication.kind,
    ).toBe('pending');
    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === child.id)?.publication.kind,
    ).toBe('pending');
    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === independent.id)?.publication
        .kind,
    ).toBe('published');
    expect(remote.creations.map((creation) => creation.title).sort()).toEqual([
      'Independent new note',
      'Refused parent',
    ]);
    expect(transport.downloaded).toContain(existing.id);
    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === existing.id)?.bodyAvailable,
    ).toBe(true);
  });

  it('preserves old workspace drafts without replaying them after a note moves', async () => {
    const original = note(1);
    await saved(original);
    transport.drafts.add(scope(original.id));
    const destination = { ...WORKSPACE, id: uuid(20_000), name: 'Destination workspace' };
    const moved = { ...original, workspaceId: destination.id };
    const remote = core([moved], { workspaces: [WORKSPACE, destination] });

    await synchronize(remote.client);
    await synchronize(remote.client);

    const copies = getOfflineSnapshot().notes;
    expect(copies).toHaveLength(2);
    expect(copies.find((candidate) => candidate.workspaceId === WORKSPACE.id)).toMatchObject({
      id: original.id,
      canWrite: false,
      bodyAvailable: false,
    });
    expect(copies.find((candidate) => candidate.workspaceId === destination.id)).toMatchObject({
      bodyAvailable: true,
      publication: { kind: 'published', serverId: original.id },
    });
    expect(await readBodyCache(scope(original.id))).toBeNull();
    expect(await readBodyCache(scope(original.id, SUBJECT, destination.id))).not.toBeNull();
    expect(transport.drafts).toContain(scope(original.id));
    expect(transport.migrations).toEqual([]);
  });

  it('attaches a moved child to the destination parent alias on its first download', async () => {
    const parent = note(600, { hasChildren: true });
    const child = note(601, { parentId: parent.id });
    await saved(parent);
    await saved(child);
    transport.drafts.add(scope(parent.id));
    const destination = { ...WORKSPACE, id: uuid(20_000), name: 'Destination workspace' };
    const remote = core(
      [
        { ...parent, workspaceId: destination.id },
        { ...child, workspaceId: destination.id },
      ],
      { workspaces: [WORKSPACE, destination] },
    );

    await synchronize(remote.client);

    const copies = getOfflineSnapshot().notes;
    const movedParent = copies.find(
      (candidate) =>
        candidate.workspaceId === destination.id &&
        candidate.publication.kind === 'published' &&
        candidate.publication.serverId === parent.id,
    );
    const movedChild = copies.find(
      (candidate) =>
        candidate.workspaceId === destination.id &&
        candidate.publication.kind === 'published' &&
        candidate.publication.serverId === child.id,
    );
    expect(copies).toHaveLength(3);
    expect(copies.find((candidate) => candidate.id === parent.id)).toMatchObject({
      workspaceId: WORKSPACE.id,
      bodyAvailable: false,
      canWrite: false,
    });
    expect(movedParent?.id).not.toBe(parent.id);
    expect(movedChild?.parentId).toBe(movedParent?.id);
    expect(movedChild?.parentId).not.toBe(parent.id);
    expect(transport.drafts).toContain(scope(parent.id));
  });

  it('flushes a moved note before sealing its old workspace and preserves its final edit', async () => {
    const original = note(1);
    await saved(original);
    const oldScope = scope(original.id);
    const cached = await readBodyCache(oldScope);
    if (cached === null) throw new Error('Missing original cache');
    transport.beforeFlush = async (flushedScope) => {
      expect(flushedScope).toBe(oldScope);
      expect(getOfflineSnapshot().notes[0]).toMatchObject({
        id: original.id,
        canWrite: false,
        bodyAvailable: true,
      });
      expect(await readBodyCache(flushedScope)).not.toBeNull();
      transport.drafts.add(flushedScope);
    };
    const destination = { ...WORKSPACE, id: uuid(20_000), name: 'Destination workspace' };
    const remote = core([{ ...original, workspaceId: destination.id }], {
      workspaces: [WORKSPACE, destination],
    });

    await synchronize(remote.client);

    expect(getOfflineSnapshot().notes).toHaveLength(2);
    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === original.id),
    ).toMatchObject({
      workspaceId: WORKSPACE.id,
      canWrite: false,
      bodyAvailable: false,
    });
    expect(transport.drafts).toContain(oldScope);
    await writeBodyCache(cached);
    expect(await readBodyCache(oldScope)).toBeNull();
    expect(await readBodyCache(scope(original.id, SUBJECT, destination.id))).not.toBeNull();
  });

  it('aborts old account downloads before they can write another account collection', async () => {
    const remoteNote = note(1);
    transport.beforeBodySave = async () => {
      await rememberOfflineAccount({ subject: OTHER_SUBJECT, name: 'Another person', email: null });
      await openBodyCache(OTHER_SUBJECT);
    };
    const remote = core([remoteNote]);

    await expect(synchronize(remote.client)).rejects.toThrow('account changed');

    expect(getOfflineSnapshot().account?.subject).toBe(OTHER_SUBJECT);
    expect(getOfflineSnapshot().notes).toEqual([]);
    expect(await readBodyCache(scope(remoteNote.id, OTHER_SUBJECT))).toBeNull();
  });

  it('rejects a delayed creation response after the same account signs in to a new lifecycle', async () => {
    const original = await createOfflineNote(WORKSPACE.id, null, 'Earlier lifecycle');
    let announceCreation = (): void => undefined;
    let resumeResponse = (): void => undefined;
    const creationStarted = new Promise<void>((resolve) => {
      announceCreation = resolve;
    });
    const responseWaiting = new Promise<void>((resolve) => {
      resumeResponse = resolve;
    });
    const remote = core([], {
      onCreate: async () => {
        announceCreation();
        await responseWaiting;
      },
    });
    const earlierRun = synchronize(remote.client);
    const rejection = expect(earlierRun).rejects.toThrow('account changed');
    await creationStarted;
    forgetOfflineAccount(SUBJECT);
    await clearBodyCache(SUBJECT);
    await openBodyCache(SUBJECT);
    await rememberOfflineAccount({ subject: SUBJECT, name: 'Offline person', email: null });
    const fresh = await createOfflineNote(WORKSPACE.id, null, 'Fresh lifecycle');

    resumeResponse();
    await rejection;

    expect(transport.migrations).toEqual([]);
    expect(
      getOfflineSnapshot().notes.find((candidate) => candidate.id === original.id),
    ).toMatchObject({
      publication: original.publication,
    });
    expect(getOfflineSnapshot().notes.find((candidate) => candidate.id === fresh.id)).toEqual(
      fresh,
    );
    expect(remote.creations).toHaveLength(1);
    expect(remote.creations[0]?.idempotencyKey).toBe(
      original.publication.kind === 'pending' ? original.publication.key : undefined,
    );
  });

  it('removes inaccessible copies after a complete scan and preserves unsynced work', async () => {
    const removed = note(1);
    const pending = note(2);
    await saved(removed);
    await saved(pending);
    transport.drafts.add(scope(pending.id));
    const remote = core([]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot().notes).toHaveLength(1);
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: pending.id,
      canWrite: false,
      bodyAvailable: false,
    });
    expect(getOfflineSnapshot().notes[0]?.blockedReason).toContain('pending edits');
    expect(await readBodyCache(scope(removed.id))).toBeNull();
    expect(await readBodyCache(scope(pending.id))).toBeNull();
    expect(transport.drafts).toContain(scope(pending.id));
  });

  it('flushes the last buffered edit before deciding whether a missing note needs recovery', async () => {
    const remoteNote = note(1);
    const original = await saved(remoteNote);
    const cached = await readBodyCache(scope(remoteNote.id));
    if (cached === null) throw new Error('Missing original cache');
    transport.beforeFlush = async (flushedScope) => {
      expect(flushedScope).toBe(scope(remoteNote.id));
      expect(getOfflineSnapshot().notes[0]).toMatchObject({
        id: original.id,
        canWrite: false,
        bodyAvailable: true,
      });
      expect(await readBodyCache(flushedScope)).not.toBeNull();
      transport.drafts.add(flushedScope);
    };
    const remote = core([]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: remoteNote.id,
      bodyAvailable: false,
      canWrite: false,
    });
    expect(getOfflineSnapshot().pending).toBe(1);
    expect(transport.drafts).toContain(scope(remoteNote.id));
    await writeBodyCache(cached);
    expect(await readBodyCache(scope(remoteNote.id))).toBeNull();
  });

  it('preserves a frozen body and metadata when the final buffered edit cannot reach disk', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    transport.beforeFlush = () => Promise.reject(new Error('Device storage is full'));
    const remote = core([]);

    await expect(synchronize(remote.client)).rejects.toThrow('Device storage is full');

    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: remoteNote.id,
      canWrite: false,
      bodyAvailable: true,
    });
    expect(await readBodyCache(scope(remoteNote.id))).not.toBeNull();
  });

  it('reopens a refused copy only after a fresh visible and unlocked Core scan', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    transport.drafts.add(scope(remoteNote.id));
    const lockRefusals = new Map([[remoteNote.id, 403]]);
    const remote = core([remoteNote], { lockRefusals });
    await synchronize(remote.client);
    expect(await readBodyCache(scope(remoteNote.id))).toBeNull();

    lockRefusals.clear();
    await synchronize(remote.client);

    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      id: remoteNote.id,
      bodyAvailable: true,
      canWrite: true,
      blockedReason: null,
    });
    expect(await readBodyCache(scope(remoteNote.id))).not.toBeNull();
  });

  it('keeps a locked copy sealed when a later unlocked scan attempts fresh readmission', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    transport.drafts.add(scope(remoteNote.id));
    const lockRefusals = new Map([[remoteNote.id, 423]]);
    const remote = core([remoteNote], { lockRefusals });
    await synchronize(remote.client);

    lockRefusals.clear();
    await synchronize(remote.client);

    expect(getOfflineSnapshot().status).toBe('error');
    expect(getOfflineSnapshot().notes[0]).toMatchObject({
      bodyAvailable: false,
      canWrite: false,
    });
    expect(await readBodyCache(scope(remoteNote.id))).toBeNull();
  });

  it.each(['body_locked', 'internal.body_locked', 'items.locked'])(
    'keeps an HTTP lock refusal %s permanent across fresh readmission attempts',
    async (code) => {
      const remoteNote = note(1);
      await saved(remoteNote);
      transport.drafts.add(scope(remoteNote.id));
      transport.failures.set(remoteNote.id, NixApiError.fromProblemDetails(403, { code }));
      const remote = core([remoteNote]);
      await synchronize(remote.client);

      transport.failures.clear();
      await synchronize(remote.client);

      expect(getOfflineSnapshot().status).toBe('error');
      expect(getOfflineSnapshot().notes[0]).toMatchObject({
        canWrite: false,
        bodyAvailable: false,
      });
      expect(await readBodyCache(scope(remoteNote.id))).toBeNull();
    },
  );

  it('seals previously cached bodies when Nix refuses their synchronization', async () => {
    const remoteNote = note(1);
    await saved(remoteNote);
    transport.drafts.add(scope(remoteNote.id));
    transport.failures.set(remoteNote.id, NixApiError.fromStatus(403));
    const remote = core([remoteNote]);

    await synchronize(remote.client);

    expect(getOfflineSnapshot()).toMatchObject({ status: 'error', pending: 1 });
    expect(getOfflineSnapshot().notes[0]).toMatchObject({ canWrite: false, bodyAvailable: false });
    expect(await readBodyCache(scope(remoteNote.id))).toBeNull();
    expect(transport.drafts).toContain(scope(remoteNote.id));
  });
});
