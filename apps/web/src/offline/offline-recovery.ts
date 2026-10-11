import { documentScope } from '../editor/body-cache';
import { readDrafts } from '../editor/draft-journal';
import { readOfflineAccount, type OfflineNote } from './offline-store';

/** Recovery keeps the author's pending updates without reading the refused confirmed body. */
export async function offlineRecoveryFile(
  note: OfflineNote,
  expectedSubject: string,
): Promise<Blob> {
  const account = readOfflineAccount();
  if (account === null) throw new Error('Sign in to recover this account’s pending edits.');
  if (account.subject !== expectedSubject) throw new Error('The offline account changed.');
  const ids = new Set([note.id]);
  if (note.publication.kind !== 'pending') ids.add(note.publication.serverId);
  const records = (
    await Promise.all(
      [...ids].map((id) => {
        const scope = documentScope(account.subject, note.workspaceId, id, 'note');
        if (scope === undefined) throw new Error('The note has no recovery scope.');
        return readDrafts(scope);
      }),
    )
  ).flat();
  if (readOfflineAccount()?.subject !== account.subject)
    throw new Error('The offline account changed.');
  if (records.length === 0 && note.pendingTitle === null && note.publication.kind === 'published') {
    throw new Error('This note has no pending local edits to export.');
  }
  return new Blob(
    [
      JSON.stringify({
        format: 'nix-offline-recovery-v1',
        workspaceId: note.workspaceId,
        localItemId: note.id,
        serverItemId: note.publication.kind === 'pending' ? null : note.publication.serverId,
        pendingTitle:
          note.pendingTitle ?? (note.publication.kind === 'published' ? null : note.title),
        updates: records.map((record) => ({
          docId: record.docId ?? null,
          update: [...record.update],
        })),
      }),
    ],
    { type: 'application/json' },
  );
}
