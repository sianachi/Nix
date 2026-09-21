import { imports, operations, type DocumentImport } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import type { Session } from '../session.ts';

export interface DocumentImportCommitReceipt {
  readonly importId: string;
  readonly operationId: string;
  readonly status: string;
}

/** Reads durable document import state without exposing any object capability. */
export async function getDocumentImport(
  profileName: string | undefined,
  importId: string,
  deps: SessionDeps = {},
): Promise<DocumentImport> {
  return getDocumentImportFromSession(await resolveSession(profileName, deps), importId);
}

export async function getDocumentImportFromSession(
  session: Session,
  importId: string,
): Promise<DocumentImport> {
  const state = await session.client.query(imports.documentImportById(importId), {
    forceRefresh: true,
  });
  return state;
}

/** Starts the Core-authorized commit and optionally waits for its durable result. */
export async function commitDocumentImport(
  profileName: string | undefined,
  importId: string,
  wait: boolean,
  deps: SessionDeps = {},
): Promise<DocumentImport | DocumentImportCommitReceipt> {
  return commitDocumentImportFromSession(await resolveSession(profileName, deps), importId, wait);
}

export async function commitDocumentImportFromSession(
  session: Session,
  importId: string,
  wait: boolean,
): Promise<DocumentImport | DocumentImportCommitReceipt> {
  const operation = await session.client.execute(imports.commitDocumentImport(importId));
  if (!wait) {
    const receipt = { importId, operationId: operation.id, status: operation.status };
    return receipt;
  }
  await operations.waitForOperation(session.client, operation.id);
  const state = await session.client.query(imports.documentImportById(importId), {
    forceRefresh: true,
  });
  if (state.status !== 'completed' || state.rootItemId === null) {
    throw new Error(state.failureCode ?? 'The document import did not publish.');
  }
  return state;
}

/** Cancels a durable document import. Caller surfaces must obtain explicit confirmation. */
export async function cancelDocumentImport(
  profileName: string | undefined,
  importId: string,
  deps: SessionDeps = {},
): Promise<{ readonly cancelled: true; readonly importId: string }> {
  return cancelDocumentImportFromSession(await resolveSession(profileName, deps), importId);
}

export async function cancelDocumentImportFromSession(
  session: Session,
  importId: string,
): Promise<{ readonly cancelled: true; readonly importId: string }> {
  await session.client.execute(imports.cancelDocumentImport(importId));
  const result = { cancelled: true as const, importId };
  return result;
}
