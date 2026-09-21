import { operations, type Operation } from '@nix/api-client';
import type { Session } from '../session.ts';
import { printResult, type OutputOptions } from '../output.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

export async function executeOperationGet(
  session: Session,
  operationId: string,
): Promise<Operation> {
  return session.client.query(operations.operationById(operationId), { forceRefresh: true });
}

export async function getOperation(
  profileName: string | undefined,
  operationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeOperationGet(session, operationId), output);
}
