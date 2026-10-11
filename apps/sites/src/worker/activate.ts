import { TransferError, type ObjectTransfer } from '../shared/object-transfer.ts';
import type { CoreClient } from './core-client.ts';
import type { JobContext } from './dispatch.ts';

const MANIFEST_BYTES = 64 * 1024;

/**
 * One `site.activate` job: apply the host-manifest writes and deletes of a rollback, an unpublish
 * or a hostname change. Core composed the bytes and signed each capability; the worker carries
 * them and reports back. Re-running is safe: a replacing write repeats and a delete of an absent
 * object succeeds.
 *
 * A delete is conditional: the manifest is read first and removed only while it still names this
 * site, so a hostname another site has verified since is never taken down by a stale withdrawal.
 */
export async function activateSite(
  deps: { readonly core: CoreClient; readonly objects: ObjectTransfer },
  context: JobContext,
): Promise<unknown> {
  const { execution, signal } = context;
  const activation = await deps.core.activation(execution, signal);
  for (const op of activation.ops) {
    signal.throwIfAborted();
    if (op.op === 'put') {
      await deps.objects.putReplacing(op.url, Buffer.from(op.body ?? '', 'utf8'), signal);
    } else if (await namesSite(deps.objects, op.readUrl, activation.siteId, signal)) {
      // shortcut: read-then-delete is not atomic, so a manifest another site writes in between can
      // be removed; send an If-Match delete with the read ETag once the object store supports it.
      await deps.objects.delete(op.url, signal);
    }
  }
  await deps.core.applied(execution, signal);
  return {
    activationId: activation.activationId,
    reason: activation.reason,
    applied: activation.ops.length,
  };
}

/** Whether the stored manifest names `siteId`; an absent manifest has nothing to delete. */
async function namesSite(
  objects: ObjectTransfer,
  readUrl: string | null,
  siteId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (readUrl === null) return false;
  let bytes: Uint8Array;
  try {
    bytes = await objects.download(readUrl, MANIFEST_BYTES, signal);
  } catch (error) {
    if (error instanceof TransferError && error.status === 404) return false;
    throw error;
  }
  try {
    const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as { siteId?: unknown };
    return manifest.siteId === siteId;
  } catch {
    // Not a manifest Core wrote; leave it for an operator rather than guess.
    return false;
  }
}
