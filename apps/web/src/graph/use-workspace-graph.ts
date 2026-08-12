import { workspaceGraphSchema, type WorkspaceGraph } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-provider';

/**
 * One workspace, as nodes and reference edges.
 *
 * Talks to Core with `fetch` rather than through `@nix/api-client`'s cache layer, for the reason
 * `use-workspace-tree.ts` gives: the descriptor executor wants a configured `NixClient` and this
 * needs one thing, a bearer token per request. Both hooks change together when that is wired, and
 * the schema below is the same one the client resource would have used, so the parse is not
 * duplicated logic - only the transport is.
 *
 * **Parsed, not cast.** A drawing built from an unvalidated payload fails as a picture rather than
 * as an error: a missing `parentId` becomes a node quietly promoted to a root, and nobody finds out.
 * Zod turns that into a state this hook can report.
 *
 * **One request for the whole graph**, unlike the tree's per-folder reads. That is the right shape
 * here and not an inconsistency: a graph is a claim about how things connect, and a partial one
 * would draw two clusters as unconnected when they are not. The server bounds the response instead,
 * and says so in the flags this hook passes straight through.
 */

/** The workspace the shell is scoped to, read exactly as `use-workspace-tree.ts` reads it. */
function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

const WORKSPACE_ID = readWorkspaceId();

/**
 * Why a failed read failed, in words a reader can act on.
 *
 * **Keyed on the problem's `code`, not on the status alone, and that distinction is not
 * theoretical.** Core answers `404 workspaces.not_found` for a workspace the caller may not see -
 * deliberately, so a response cannot confirm one exists. But a request that reaches a server with
 * no such route *also* answers 404, with no body at all, and the first version of this hook
 * reported that as "This workspace could not be found." It sent a real debugging session looking
 * for a permission bug that was never there: the server was simply running a build older than the
 * endpoint.
 *
 * So a 404 carrying the code is the refusal it claims to be, and a 404 without one is this build
 * asking a server that does not offer the endpoint - which is a deployment fact, and worth saying
 * out loud rather than dressing up as an authorization result.
 */
async function refusal(response: Response): Promise<string> {
  const code: unknown = await response
    .json()
    .then((body: unknown) =>
      typeof body === 'object' && body !== null && 'code' in body ? body.code : null,
    )
    // A body that is absent or is not JSON at all - which is exactly what a routing 404 sends.
    .catch(() => null);

  if (code === 'workspaces.not_found') {
    return 'This workspace could not be found.';
  }

  if (response.status === 404) {
    return 'This version of the application asked for a graph the server does not offer. The server may be running an older build.';
  }

  return 'The graph could not be loaded.';
}

export type GraphStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceGraphState {
  readonly status: GraphStatus;

  /** The payload, or null while loading and after a failure. Never a half-built stand-in. */
  readonly graph: WorkspaceGraph | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export function useWorkspaceGraph(): WorkspaceGraphState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<GraphStatus>('loading');
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch(`/api/v1/workspaces/${WORKSPACE_ID}/graph`, {
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      });

      if (!response.ok) {
        setStatus('error');
        setError(await refusal(response));
        return;
      }

      const parsed = workspaceGraphSchema.safeParse(await response.json());
      if (!parsed.success) {
        setStatus('error');
        setError('The graph came back in a shape this version does not understand.');
        return;
      }

      setGraph(parsed.data);
      setStatus('ready');
    } catch {
      // A dropped connection, an aborted request, or a body that is not JSON at all. None of them
      // tells the reader anything they can act on beyond "try again", which the panel offers.
      setStatus('error');
      setError('The graph could not be loaded.');
    }
  }, [getAccessToken]);

  // Deferred a microtask, the same way `use-current-principal.ts` defers its own first read.
  // `load` sets state on its first line, and doing that synchronously inside an effect body is the
  // cascading-render pattern `react-hooks/set-state-in-effect` exists to stop.
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, graph, error, reload: load };
}
