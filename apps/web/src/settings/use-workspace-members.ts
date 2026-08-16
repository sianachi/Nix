import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { useAuth } from '../auth/auth-provider';

/**
 * The workspace's members: who holds a role here, from
 * `GET /api/v1/workspaces/{workspaceId}/members`.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, for the
 * same reason `use-workspace-tree.ts` does: the client's descriptor execution wants a configured
 * `NixClient` and this needs one thing, a bearer token on each request.
 *
 * The schema is local rather than the package's, because `@nix/api-client` does not yet ship one
 * for role grants - unlike `use-current-principal.ts` there is no exported contract type to tie it
 * to with `satisfies`, so the runtime parse is the only guard until the package grows one. If Core
 * reshapes `RoleGrantResponse`, the parse failure below is the telemetry that says so.
 *
 * **The read follows the cursor to the end**, bounded rather than trusting the chain to terminate.
 * A settings screen that silently showed the first page of members would look complete and not be,
 * which is exactly the partial state the UI truthfulness rule exists to forbid - so a walk that
 * hits the bound reports itself as `truncated` and the section says so out loud.
 */

const roleGrantSchema = z.object({
  subjectType: z.string(),
  subjectId: z.string(),
  subjectDisplayName: z.string(),
  role: z.string(),
  grantedAt: z.string(),
});

const memberPageSchema = z.object({
  items: z.array(roleGrantSchema),
  nextCursor: z.string().nullable(),
});

export type WorkspaceMember = z.infer<typeof roleGrantSchema>;

export type WorkspaceMembersStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceMembersState {
  readonly status: WorkspaceMembersStatus;
  readonly members: readonly WorkspaceMember[];

  /** Whether the cursor walk hit its bound, so the section can say the list is incomplete. */
  readonly truncated: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * How many pages the cursor walk will follow before giving up. At the server's default page size
 * of fifty this covers a thousand members, which is far past what one workspace holds today; the
 * bound exists so a server bug that never ends the cursor cannot hang the tab.
 */
const MAX_PAGES = 20;

/**
 * The workspace the shell is scoped to - the same environment read, with the same fallback, as
 * `use-workspace-tree.ts`, which keeps its copy module-private. Real switching arrives with the
 * workspace picker, and both reads collapse into it then.
 */
function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

export function useWorkspaceMembers(): WorkspaceMembersState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<WorkspaceMembersStatus>('loading');
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setStatus('loading');
      setError(null);

      try {
        const token = await getAccessToken();
        const headers = {
          accept: 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        };

        const collected: WorkspaceMember[] = [];
        let cursor: string | null = null;
        let pagesLeft = MAX_PAGES;

        do {
          const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
          const response = await fetch(`/api/v1/workspaces/${WORKSPACE_ID}/members${query}`, {
            ...(signal === undefined ? {} : { signal }),
            headers,
          });

          if (!response.ok) {
            setError(`The members could not be loaded (${String(response.status)}).`);
            setStatus('error');
            return;
          }

          const parsed = memberPageSchema.safeParse(await response.json());
          if (!parsed.success) {
            // A parse failure is telemetry, not a silent fallback: the contract moved and this
            // build did not.
            console.warn('The members response did not match the contract:', parsed.error.message);
            setError('The members could not be read.');
            setStatus('error');
            return;
          }

          collected.push(...parsed.data.items);
          cursor = parsed.data.nextCursor;
          pagesLeft -= 1;
        } while (cursor !== null && pagesLeft > 0);

        setMembers(collected);
        setTruncated(cursor !== null);
        setStatus('ready');
      } catch (cause) {
        if (signal?.aborted === true) {
          return;
        }

        console.warn('The members read failed.', cause);
        setError('Core could not be reached.');
        setStatus('error');
      }
    },
    [getAccessToken],
  );

  useEffect(() => {
    const controller = new AbortController();
    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // the same cascade-stopper `use-workspace-tree.ts` documents.
    queueMicrotask(() => {
      void load(controller.signal);
    });

    return () => {
      controller.abort();
    };
  }, [load]);

  const reload = useCallback(async (): Promise<void> => {
    await load();
  }, [load]);

  return { status, members, truncated, error, reload };
}
