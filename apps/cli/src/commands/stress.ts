/**
 * `nixctl stress seed`: populate a container with children, at the scale the stress rows name.
 *
 * The whole point of the CLI's stress surface is that the scale runs cost no model tokens: a script
 * seeds the 3,000+ children §1.9, §2.5 and §3.13 ask for and reads them back, and no agent walks the
 * tree by hand. This is the seed half — it composes the `item create` primitive rather than adding a
 * new endpoint, so it inherits the same authorization and the same refusals.
 *
 * **It stops honestly on the write rate limit rather than grinding.** Writes are capped per IP
 * (`Nix:RateLimits:WritesPerMinute`, 120 by default), so a large seed will meet a 429; when it does,
 * the command stops and names the override to raise on the stack, and reports exactly how many
 * children it made — a partial seed said plainly, never a hang or a silent stall.
 */

import { isNixApiError, items } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** The override to name when the seed meets the write rate limit, so a person can raise it. */
const WRITES_LIMIT_OVERRIDE = 'Nix__RateLimits__WritesPerMinute';

export interface SeedOptions {
  readonly workspaceId: string;
  readonly count: number;
  /** The container to seed under; a new one is created when omitted. */
  readonly parentId?: string | undefined;
  readonly titlePrefix?: string | undefined;
  readonly type?: string | undefined;
}

/** Seeds `count` children under a container (creating one when none is given) and reports the count. */
export async function seed(
  profileName: string | undefined,
  options: SeedOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error(`--count must be a positive integer, got '${String(options.count)}'.`);
  }

  const session = await resolveSession(profileName, deps);
  const type = options.type ?? 'note';
  const prefix = options.titlePrefix ?? 'Item';

  // Create the parent first when one was not given, so the seed always has a container to hang the
  // children on. A note holds children like any item, so this needs no special "folder" kind.
  const parentId =
    options.parentId ??
    (
      await session.client.execute(
        items.createItem(options.workspaceId, {
          type: 'note',
          title: `Stress seed (${String(options.count)})`,
        }),
      )
    ).id;

  let created = 0;
  let stoppedEarly = false;
  let reason: string | undefined;

  for (let index = 0; index < options.count; index += 1) {
    try {
      await session.client.execute(
        items.createItem(options.workspaceId, {
          type,
          title: `${prefix} ${String(index + 1)}`,
          parentId,
        }),
      );
      created += 1;
    } catch (error) {
      // The write rate limit is an expected outcome of seeding at scale, not a bug: stop, keep what
      // was made, and name the override. Anything else is a real failure and propagates.
      if (isNixApiError(error) && error.status === 429) {
        stoppedEarly = true;
        reason = `Hit the write rate limit after ${String(created)} children. Raise ${WRITES_LIMIT_OVERRIDE} on the stack to seed faster.`;
        break;
      }
      throw error;
    }
  }

  printResult(
    {
      workspaceId: options.workspaceId,
      parentId,
      requested: options.count,
      created,
      stoppedEarly,
      ...(reason !== undefined ? { reason } : {}),
    },
    output,
  );
}
