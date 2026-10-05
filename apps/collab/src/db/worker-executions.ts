import type { ScopedQuery } from './tenant-scope.ts';

/**
 * Which worker execution a write is being made by, and the kind of job it must be running.
 *
 * The kind is part of the question, not a description of the caller: a lease on an import job
 * proves nothing about the right to append a transcript, so each write names the one kind of job
 * that may make it and the fence refuses any other.
 */
export interface WorkerExecutionFence {
  readonly jobId: string;
  readonly executionId: string;
  readonly kind: 'import.commit' | 'template.commit' | 'transcribe.audio';
}

/**
 * Whether this worker execution still holds its job's lease, asked inside the caller's
 * transaction.
 *
 * The function locks the job row until that transaction ends, so a lease cannot be lost and
 * handed to another execution between this answer and the commit of the write it guards. The
 * answer is a boolean rather than a throw so each caller refuses in its own vocabulary.
 *
 * Here rather than beside any one caller because every worker-driven body write asks it - staged
 * imports, template imports, transcript appends - and none of them owns it.
 */
export async function workerExecutionHeld(
  sql: ScopedQuery,
  owner: { readonly tenantId: string; readonly workspaceId: string; readonly principalId: string },
  fence: WorkerExecutionFence,
): Promise<boolean> {
  const result = await sql.query<{ authorized: boolean }>(
    `SELECT nix_fence_worker_execution(
         $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid) AS authorized`,
    [
      fence.jobId,
      fence.executionId,
      fence.kind,
      owner.tenantId,
      owner.workspaceId,
      owner.principalId,
    ],
  );
  return result.rows.length === 1 && result.rows[0]?.authorized === true;
}
