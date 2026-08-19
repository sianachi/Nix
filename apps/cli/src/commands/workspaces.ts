/**
 * `nixctl ws`: the workspaces a token can reach.
 *
 * The list is the first thing a scripted session reads, because every item command needs a
 * workspace id and this is where they come from. It walks every page rather than showing the first
 * one - a caller piping to `jq` wants the whole set, not a cursor to chase.
 */

import { workspaces } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** Lists every workspace the profile can reach. */
export async function listWorkspaces(
  profileName: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);

  const items: { id: string; name: string; createdAt: string }[] = [];
  for await (const workspace of session.client.paginate(workspaces.listWorkspaces())) {
    items.push({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt });
  }

  printResult({ workspaces: items, count: items.length }, output);
}
