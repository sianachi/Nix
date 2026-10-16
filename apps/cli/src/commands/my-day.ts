/** `nixctl my-day`: what to do today in one workspace, as Core projects it. */

import { myDay } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/**
 * Prints the whole response unchanged. Coverage, limits and the habit's own day are the part of
 * the answer a caller must not miss, so nothing is reshaped or dropped here.
 */
export async function runMyDay(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(myDay.myDay(workspaceId)), output);
}
