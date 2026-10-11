import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDraftJournal,
  type DraftJournalStore,
  type DraftRecord,
  type DraftState,
  clearDrafts,
  acknowledgeDrafts,
  readDrafts,
  writeDraft,
  listDraftScopes,
  migrateLocalDrafts,
} from '../../editor/draft-journal';
import {
  clearBodyCache,
  documentScope,
  openBodyCache,
  readBodyCache,
  writeBodyCache,
  sealItemBodies,
  sealAccountBodies,
} from '../../editor/body-cache';

function storage(): DraftJournalStore {
  const records = new Map<string, DraftRecord>();
  return {
    read: (scope) =>
      Promise.resolve([...records.values()].filter((record) => record.scope === scope)),
    write: (record) => {
      records.set(record.id, record);
      return Promise.resolve();
    },
    acknowledge: (acknowledged) => {
      for (const record of acknowledged)
        if (records.get(record.id)?.revision === record.revision) records.delete(record.id);
      return Promise.resolve();
    },
  };
}
function update(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('note').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
describe('pending note drafts', () => {
  it('recovers a locally saved edit in a new editor without crossing account scopes', async () => {
    const store = storage();
    const states: DraftState[] = [];
    const first = createDraftJournal('alice:workspace:note', (state) => states.push(state), store);
    first.append(update('Recover me'));
    await first.snapshot();
    expect(states).toEqual(['saving', 'local']);
    const reopened = createDraftJournal('alice:workspace:note', () => undefined, store);
    const records = await reopened.read();
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toBe('Recover me');
    expect(await createDraftJournal('bob:workspace:note', () => undefined, store).read()).toEqual(
      [],
    );
    doc.destroy();
  });
  it('does not acknowledge another active tab’s unsent edits', async () => {
    const store = storage();
    const first = createDraftJournal('same-note', () => undefined, store);
    const second = createDraftJournal('same-note', () => undefined, store);
    await first.read();
    await second.read();
    first.append(update('First'));
    second.append(update('Second'));
    const secondRecords = await second.snapshot();
    await first.acknowledge(await first.snapshot());
    expect(await store.read('same-note')).toEqual(secondRecords);
  });
  it('retains edits made while the server acknowledges an earlier revision', async () => {
    const store = storage();
    const journal = createDraftJournal('note', () => undefined, store);
    journal.append(update('First'));
    const earlier = await journal.snapshot();
    journal.append(update('Later'));
    const later = await journal.snapshot();
    await journal.acknowledge(earlier);
    expect(await store.read('note')).toEqual(later);
  });
  it('reports storage refusal without claiming a local save', async () => {
    const states: DraftState[] = [];
    const store = storage();
    store.write = () => Promise.reject(new Error('Quota exceeded'));
    const journal = createDraftJournal('note', (state) => states.push(state), store);
    journal.append(update('Keep in the open tab'));
    await expect(journal.snapshot()).rejects.toThrow('Quota exceeded');
    expect(states).toEqual(['saving', 'error']);
  });
  it('discards and disables the journal when editing permission is revoked', async () => {
    const store = storage();
    const journal = createDraftJournal('note', () => undefined, store);
    journal.append(update('Before revocation'));
    await journal.discard();
    journal.append(update('After revocation'));
    expect(await journal.snapshot()).toEqual([]);
  });
});

describe('account-scoped draft persistence', () => {
  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    await clearBodyCache();
    await clearDrafts();
    await openBodyCache('alice');
  });

  const scope = (itemId: string): string =>
    documentScope('alice', 'workspace', itemId, 'note') ?? '';

  it('rejects a late write after sign-out and does not expose another account’s pending scopes', async () => {
    const journal = createDraftJournal(scope('late'), () => undefined);
    journal.append(update('Written before sign-out'));
    await journal.snapshot();
    expect(await listDraftScopes('alice')).toEqual([scope('late')]);
    expect(await listDraftScopes('bob')).toEqual([]);
    await sealItemBodies('alice', 'workspace', 'late');
    expect(await listDraftScopes('alice')).toEqual([scope('late')]);
    await expect(acknowledgeDrafts(await readDrafts(scope('late')))).rejects.toThrow('closed');
    expect(await readDrafts(scope('late'))).toHaveLength(1);
    await clearBodyCache();
    await expect(
      writeDraft({
        id: 'late',
        scope: scope('late'),
        revision: 1,
        update: update('After sign-out'),
      }),
    ).rejects.toThrow('closed');
  });

  it('lists duplicate draft records once per scope and only for the admitted account', async () => {
    for (const [id, itemId] of [
      ['one', 'same'],
      ['two', 'same'],
      ['three', 'other'],
    ] as const)
      await writeDraft({
        id,
        scope: scope(itemId),
        revision: 0,
        update: update(id),
      });
    await openBodyCache('bob');
    await writeDraft({
      id: 'bob-draft',
      scope: documentScope('bob', 'workspace', 'same', 'note') ?? '',
      revision: 0,
      update: update('Other account'),
    });
    await openBodyCache('alice');
    await sealItemBodies('alice', 'workspace', 'same');
    expect(await listDraftScopes('alice')).toEqual([scope('other'), scope('same')]);
    expect(await listDraftScopes('bob')).toEqual([]);
    expect(await readDrafts(scope('same'))).toHaveLength(2);
  });

  it('recovers more than 128 editor instances without discarding their updates', async () => {
    for (let index = 0; index < 129; index += 1)
      await writeDraft({
        id: String(index),
        scope: scope('many'),
        revision: 0,
        docId: 'doc',
        update: update(String(index)),
      });
    expect(await readDrafts(scope('many'))).toHaveLength(129);
  });

  it('publishes a local note’s complete state and pending edits once, preserving retries', async () => {
    const localId = 'local-note';
    const fromScope = scope(localId);
    const toScope = scope('server-note');
    const doc = new Y.Doc();
    doc.getText('note').insert(0, 'Initial text');
    const base = Y.encodeStateAsUpdate(doc);
    const vector = Y.encodeStateVector(doc);
    doc.getText('note').insert(12, ' and offline edit');
    await writeBodyCache({
      scope: fromScope,
      docId: `local:${localId}`,
      schemaVersion: 1,
      savedAt: Date.now(),
      update: base,
    });
    await writeDraft({
      id: 'local-edit',
      scope: fromScope,
      revision: 1,
      docId: `local:${localId}`,
      update: Y.encodeStateAsUpdate(doc, vector),
    });
    await migrateLocalDrafts(fromScope, toScope);
    await migrateLocalDrafts(fromScope, toScope);
    const records = await readDrafts(toScope);
    expect(records).toHaveLength(1);
    expect(records[0]?.docId).toBe('local:server-note');
    const reopened = new Y.Doc();
    for (const record of records) Y.applyUpdate(reopened, record.update);
    expect(reopened.getText('note').toJSON()).toBe('Initial text and offline edit');
    expect(await readDrafts(fromScope)).toEqual([]);
    expect(await readBodyCache(fromScope)).toBeNull();
    await writeDraft({ id: 'late-source', scope: fromScope, revision: 1, update: update('Late') });
    expect(await readDrafts(fromScope)).toEqual([]);
    expect(await readDrafts(toScope)).toHaveLength(2);
    doc.destroy();
    reopened.destroy();
  });

  it('recovers authored local drafts after an account closure removed their empty creation base', async () => {
    const fromScope = scope('lost-base');
    const toScope = scope('created-server');
    const empty = new Y.Doc();
    await writeBodyCache({
      scope: fromScope,
      docId: 'local:lost-base',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: Y.encodeStateAsUpdate(empty),
    });
    empty.destroy();
    await writeDraft({
      id: 'authored-local',
      scope: fromScope,
      revision: 2,
      docId: 'local:lost-base',
      update: update('Offline authored text'),
    });
    await sealAccountBodies('alice');
    await openBodyCache('alice', { reauthorized: true });
    expect(await readBodyCache(fromScope)).toBeNull();
    await expect(migrateLocalDrafts(fromScope, toScope)).rejects.toThrow(
      'existing server document',
    );
    expect(await readDrafts(fromScope)).toHaveLength(1);
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'created-server' });
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'created-server' });
    const records = await readDrafts(toScope);
    expect(records).toHaveLength(1);
    expect(records[0]?.docId).toBe('local:created-server');
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toBe('Offline authored text');
    expect(await readDrafts(fromScope)).toEqual([]);
    expect(await readBodyCache(toScope)).toBeNull();
    doc.destroy();
  });

  it.each(['local:another-note', 'existing-server-doc', undefined])(
    'preserves missing-base drafts with unproven identity %s',
    async (docId) => {
      const fromScope = scope('unproven-local');
      const toScope = scope('created-server');
      await writeDraft({
        id: 'unproven',
        scope: fromScope,
        revision: 1,
        ...(docId === undefined ? {} : { docId }),
        update: update('Keep pending'),
      });
      await expect(
        migrateLocalDrafts(fromScope, toScope, { createdItemId: 'created-server' }),
      ).rejects.toThrow('original document identity');
      expect(await readDrafts(fromScope)).toHaveLength(1);
      expect(await readDrafts(toScope)).toEqual([]);
    },
  );

  it.each(['insert', 'delete'])(
    'preserves a local %s update that requires a missing base',
    async (operation) => {
      const fromScope = scope('incomplete-local');
      const doc = new Y.Doc();
      doc.getText('note').insert(0, 'Missing base');
      const vector = Y.encodeStateVector(doc);
      if (operation === 'insert') doc.getText('note').insert(12, ' delta');
      else doc.getText('note').delete(0, 7);
      await writeDraft({
        id: 'delta',
        scope: fromScope,
        revision: 1,
        docId: 'local:incomplete-local',
        update: Y.encodeStateAsUpdate(doc, vector),
      });
      await expect(
        migrateLocalDrafts(fromScope, scope('created-server'), { createdItemId: 'created-server' }),
      ).rejects.toThrow('missing document base');
      expect(await readDrafts(fromScope)).toHaveLength(1);
      doc.destroy();
    },
  );

  it.each(['insert', 'delete'])(
    'retains a late local %s update requiring a missing base during the atomic transfer',
    async (operation) => {
      const fromScope = scope('late-incomplete');
      const toScope = scope('late-server');
      await writeDraft({
        id: 'complete-first',
        scope: fromScope,
        revision: 1,
        docId: 'local:late-incomplete',
        update: update('Complete original text'),
      });
      const doc = new Y.Doc();
      doc.getText('note').insert(0, 'Absent concurrent base');
      const vector = Y.encodeStateVector(doc);
      if (operation === 'insert') doc.getText('note').insert(22, ' delta');
      else doc.getText('note').delete(0, 7);
      const lateRecord = {
        id: 'late-incomplete',
        scope: fromScope,
        revision: 1,
        docId: 'local:late-incomplete',
        update: Y.encodeStateAsUpdate(doc, vector),
      };
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the originating index below.
      const getAll = IDBIndex.prototype.getAll;
      let lateWrite: Promise<void> | undefined;
      const probe = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (
        this: IDBIndex,
        query,
        count,
      ) {
        const request = getAll.call(this, query, count);
        if (
          query === fromScope &&
          this.objectStore.transaction.mode === 'readonly' &&
          lateWrite === undefined
        ) {
          request.addEventListener(
            'success',
            () => {
              lateWrite = writeDraft(lateRecord);
            },
            { once: true },
          );
        }
        return request;
      });
      try {
        await expect(
          migrateLocalDrafts(fromScope, toScope, { createdItemId: 'late-server' }),
        ).rejects.toThrow('Draft write aborted');
        await lateWrite;
        expect(await readDrafts(fromScope)).toHaveLength(2);
        expect(await readDrafts(toScope)).toEqual([]);
      } finally {
        probe.mockRestore();
        doc.destroy();
      }
    },
  );

  it('publishes a receipt-proven empty local note and redirects late edits after its base is removed', async () => {
    const fromScope = scope('empty-local');
    const toScope = scope('created-empty');
    await expect(migrateLocalDrafts(fromScope, toScope)).rejects.toThrow(
      'existing server document',
    );
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'created-empty' });
    const records = await readDrafts(toScope);
    expect(records).toHaveLength(1);
    expect(records[0]?.docId).toBe('local:created-empty');
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toBe('');
    expect(await readBodyCache(toScope)).toBeNull();
    await writeDraft({
      id: 'late-empty',
      scope: fromScope,
      revision: 1,
      docId: 'local:empty-local',
      update: update('Late local text'),
    });
    expect(await readDrafts(fromScope)).toEqual([]);
    const redirected = await readDrafts(toScope);
    expect(redirected.every((record) => record.docId === 'local:created-empty')).toBe(true);
    for (const record of redirected) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toBe('Late local text');
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'created-empty' });
    expect(await readDrafts(toScope)).toEqual(redirected);
    doc.destroy();
  });

  it('establishes a redirect for an empty receipt-proven source whose server body was already downloaded', async () => {
    const fromScope = scope('empty-downloaded');
    const toScope = scope('downloaded-server');
    await writeBodyCache({
      scope: toScope,
      docId: 'downloaded-canonical',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: update('Confirmed server text'),
    });
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'downloaded-server' });
    await writeDraft({
      id: 'late-downloaded',
      scope: fromScope,
      revision: 1,
      docId: 'local:empty-downloaded',
      update: update('Late local text'),
    });
    expect(await readDrafts(fromScope)).toEqual([]);
    expect(
      (await readDrafts(toScope)).every((record) => record.docId === 'downloaded-canonical'),
    ).toBe(true);
  });

  it('preserves the target draft canonical identity when its confirmed cache is absent', async () => {
    const fromScope = scope('canonical-source');
    const toScope = scope('canonical-target');
    await writeDraft({
      id: 'source-pending',
      scope: fromScope,
      revision: 1,
      docId: 'local:canonical-source',
      update: update('Local pending text'),
    });
    await writeDraft({
      id: `${toScope}:published-local`,
      scope: toScope,
      revision: 3,
      docId: 'known-canonical-document',
      update: update('Earlier published text'),
    });
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'canonical-target' });
    const records = await readDrafts(toScope);
    expect(records).toHaveLength(1);
    expect(records[0]?.docId).toBe('known-canonical-document');
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toContain('Local pending text');
    expect(doc.getText('note').toJSON()).toContain('Earlier published text');
    await writeDraft({
      id: 'late-canonical',
      scope: fromScope,
      revision: 1,
      docId: 'local:canonical-source',
      update: update('Late local text'),
    });
    expect(await readDrafts(fromScope)).toEqual([]);
    expect(
      (await readDrafts(toScope)).every((record) => record.docId === 'known-canonical-document'),
    ).toBe(true);
    doc.destroy();
  });

  it('retains both pending scopes when the cached target has replaced its known canonical document', async () => {
    const fromScope = scope('replacement-source');
    const toScope = scope('replacement-target');
    await writeDraft({
      id: 'source-pending',
      scope: fromScope,
      revision: 1,
      docId: 'local:replacement-source',
      update: update('Keep source pending'),
    });
    await writeDraft({
      id: `${toScope}:published-local`,
      scope: toScope,
      revision: 3,
      docId: 'original-canonical-document',
      update: update('Keep target pending'),
    });
    await writeBodyCache({
      scope: toScope,
      docId: 'replacement-canonical-document',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: update('Replacement text'),
    });
    const source = await readDrafts(fromScope);
    const target = await readDrafts(toScope);
    await expect(
      migrateLocalDrafts(fromScope, toScope, { createdItemId: 'replacement-target' }),
    ).rejects.toThrow('Draft write aborted');
    expect(await readDrafts(fromScope)).toEqual(source);
    expect(await readDrafts(toScope)).toEqual(target);
    expect((await readBodyCache(toScope))?.docId).toBe('replacement-canonical-document');
  });

  it.each(['another-server-document', 'local:another-note'])(
    'retains a source draft with foreign identity %s even when its local cache is valid',
    async (docId) => {
      const fromScope = scope('local-with-cache');
      const toScope = scope('foreign-draft-target');
      await writeBodyCache({
        scope: fromScope,
        docId: 'local:local-with-cache',
        schemaVersion: 1,
        savedAt: Date.now(),
        update: update('Local base'),
      });
      await writeDraft({
        id: 'foreign-draft',
        scope: fromScope,
        revision: 1,
        docId,
        update: update('Preserve foreign pending'),
      });
      const records = await readDrafts(fromScope);
      await expect(
        migrateLocalDrafts(fromScope, toScope, { createdItemId: 'foreign-draft-target' }),
      ).rejects.toThrow('Draft write aborted');
      expect(await readDrafts(fromScope)).toEqual(records);
      expect(await readDrafts(toScope)).toEqual([]);
      expect((await readBodyCache(fromScope))?.docId).toBe('local:local-with-cache');
    },
  );

  it.each(['scope', 'identity'])(
    'refuses a published target marker with an unproven %s',
    async (field) => {
      const fromScope = scope('marker-source');
      const toScope = scope('marker-target');
      await writeDraft({
        id: 'marker-source-pending',
        scope: fromScope,
        revision: 1,
        docId: 'local:marker-source',
        update: update('Keep local pending'),
      });
      await writeDraft({
        id: `${toScope}:published-local`,
        scope: field === 'scope' ? scope('another-marker') : toScope,
        revision: 3,
        ...(field === 'identity' ? {} : { docId: 'known-document' }),
        update: update('Keep unknown target pending'),
      });
      const records = await readDrafts(fromScope);
      await expect(
        migrateLocalDrafts(fromScope, toScope, { createdItemId: 'marker-target' }),
      ).rejects.toThrow('Draft write aborted');
      expect(await readDrafts(fromScope)).toEqual(records);
    },
  );

  it('rejects undecodable target bytes without deleting either pending scope', async () => {
    const fromScope = scope('corrupt-target-source');
    const toScope = scope('corrupt-target');
    await writeDraft({
      id: 'corrupt-target-source',
      scope: fromScope,
      revision: 1,
      docId: 'local:corrupt-target-source',
      update: update('Keep local pending'),
    });
    await writeDraft({
      id: `${toScope}:published-local`,
      scope: toScope,
      revision: 2,
      docId: 'known-document',
      update: new Uint8Array([255]),
    });
    const source = await readDrafts(fromScope);
    const target = await readDrafts(toScope);
    await expect(
      migrateLocalDrafts(fromScope, toScope, { createdItemId: 'corrupt-target' }),
    ).rejects.toThrow('Draft write aborted');
    expect(await readDrafts(fromScope)).toEqual(source);
    expect(await readDrafts(toScope)).toEqual(target);
  });

  it('requires the matching create receipt and cannot skip pending source edits for a cached destination', async () => {
    const fromScope = scope('missing-source');
    const toScope = scope('already-created');
    await writeDraft({
      id: 'pending-source',
      scope: fromScope,
      revision: 2,
      docId: 'local:missing-source',
      update: update('Local pending text'),
    });
    await writeBodyCache({
      scope: toScope,
      docId: 'canonical-server-doc',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: update('Remote confirmed text'),
    });
    await expect(migrateLocalDrafts(fromScope, toScope)).rejects.toThrow(
      'existing server document',
    );
    await expect(
      migrateLocalDrafts(fromScope, toScope, { createdItemId: 'another-server' }),
    ).rejects.toThrow('existing server document');
    expect(await readDrafts(fromScope)).toHaveLength(1);
    expect(await readDrafts(toScope)).toEqual([]);
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'already-created' });
    const records = await readDrafts(toScope);
    expect(records).toHaveLength(1);
    expect(records[0]?.docId).toBe('canonical-server-doc');
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toContain('Local pending text');
    expect(doc.getText('note').toJSON()).toContain('Remote confirmed text');
    expect(await readDrafts(fromScope)).toEqual([]);
    doc.destroy();
  });

  it('still refuses a source cache carrying a different document identity despite a create receipt', async () => {
    const fromScope = scope('wrong-base');
    await writeBodyCache({
      scope: fromScope,
      docId: 'different-document',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: update('Unrelated confirmed text'),
    });
    await writeDraft({
      id: 'local-tag',
      scope: fromScope,
      revision: 1,
      docId: 'local:wrong-base',
      update: update('Preserve pending'),
    });
    await expect(
      migrateLocalDrafts(fromScope, scope('created-server'), { createdItemId: 'created-server' }),
    ).rejects.toThrow('existing server document');
    expect(await readDrafts(fromScope)).toHaveLength(1);
    expect((await readBodyCache(fromScope))?.docId).toBe('different-document');
  });

  it('merges an already-downloaded created item only with its matching creation receipt', async () => {
    const fromScope = scope('receipt-local');
    const toScope = scope('receipt-server');
    await writeBodyCache({
      scope: fromScope,
      docId: 'local:receipt-local',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: update('Local text'),
    });
    await writeBodyCache({
      scope: toScope,
      docId: 'actual-server-doc',
      schemaVersion: 1,
      savedAt: Date.now(),
      update: update('Server text'),
    });
    await expect(migrateLocalDrafts(fromScope, toScope)).rejects.toThrow(
      'existing server document',
    );
    await migrateLocalDrafts(fromScope, toScope, { createdItemId: 'receipt-server' });
    await writeDraft({
      id: 'late-receipt-source',
      scope: fromScope,
      revision: 1,
      docId: 'local:receipt-local',
      update: update('Late edit'),
    });
    const records = await readDrafts(toScope);
    expect(records.every((record) => record.docId === 'actual-server-doc')).toBe(true);
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toContain('Local text');
    expect(doc.getText('note').toJSON()).toContain('Server text');
    expect(doc.getText('note').toJSON()).toContain('Late edit');
    doc.destroy();
  });
});
