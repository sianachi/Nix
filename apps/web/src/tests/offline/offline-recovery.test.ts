import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bodies from '../../editor/body-cache';
import * as journal from '../../editor/draft-journal';
import * as offline from '../../offline/offline-store';
import { offlineRecoveryFile } from '../../offline/offline-recovery';
import type { OfflineNote } from '../../offline/offline-store';

const account = { subject: 'owner', name: 'Owner', email: null };
const note: OfflineNote = {
  id: 'local-note',
  workspaceId: 'workspace',
  parentId: null,
  title: 'Previously downloaded title',
  canWrite: false,
  bodyAvailable: false,
  publication: { kind: 'published', serverId: 'server-note', docId: 'document' },
  pendingTitle: null,
  blockedReason: 'Access is no longer available.',
};

beforeEach(() => {
  vi.spyOn(offline, 'readOfflineAccount').mockReturnValue(account);
});

describe('offline note recovery', () => {
  it('exports only pending updates and never reads a refused confirmed body', async () => {
    const bodyRead = vi.spyOn(bodies, 'readBodyCache');
    const scope = bodies.documentScope(
      account.subject,
      note.workspaceId,
      note.publication.kind === 'published' ? note.publication.serverId : note.id,
      'note',
    );
    if (scope === undefined) throw new Error('The fixture has no scope.');
    vi.spyOn(journal, 'readDrafts').mockImplementation((requested) =>
      Promise.resolve(
        requested === scope
          ? [
              {
                id: 'draft',
                scope,
                revision: 1,
                docId: 'document',
                update: new Uint8Array([1, 2, 3]),
              },
            ]
          : [],
      ),
    );
    const blob = await offlineRecoveryFile(note, account.subject);
    expect(JSON.parse(await blob.text())).toEqual({
      format: 'nix-offline-recovery-v1',
      workspaceId: 'workspace',
      localItemId: 'local-note',
      serverItemId: 'server-note',
      pendingTitle: null,
      updates: [{ docId: 'document', update: [1, 2, 3] }],
    });
    expect(bodyRead).not.toHaveBeenCalled();
  });

  it('preserves a locally changed title even when there are no body edits', async () => {
    vi.spyOn(journal, 'readDrafts').mockResolvedValue([]);
    const blob = await offlineRecoveryFile(
      { ...note, pendingTitle: 'My unsynced title' },
      account.subject,
    );
    expect(JSON.parse(await blob.text())).toMatchObject({
      pendingTitle: 'My unsynced title',
      updates: [],
    });
  });

  it('refuses to export after the account changes during a read', async () => {
    vi.spyOn(journal, 'readDrafts').mockResolvedValue([]);
    vi.spyOn(offline, 'readOfflineAccount').mockReturnValueOnce(account).mockReturnValue(null);
    await expect(
      offlineRecoveryFile({ ...note, pendingTitle: 'Unsynced title' }, account.subject),
    ).rejects.toThrow('account changed');
  });

  it('refuses an export initiated by a previous account before reading any drafts', async () => {
    const read = vi.spyOn(journal, 'readDrafts').mockResolvedValue([]);
    await expect(
      offlineRecoveryFile({ ...note, pendingTitle: 'Private title' }, 'previous-owner'),
    ).rejects.toThrow('account changed');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses to label an empty file as pending-edit recovery', async () => {
    vi.spyOn(journal, 'readDrafts').mockResolvedValue([]);
    await expect(offlineRecoveryFile(note, account.subject)).rejects.toThrow(
      'no pending local edits',
    );
  });
});
