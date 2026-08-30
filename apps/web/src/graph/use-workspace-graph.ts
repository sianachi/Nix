import {
  isCanceledError,
  isNixApiError,
  workspaceGraph as coreWorkspaceGraph,
  type WorkspaceGraph,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';

export type GraphStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceGraphState {
  readonly status: GraphStatus;
  readonly graph: WorkspaceGraph | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

function graphError(reason: unknown): string {
  if (isNixApiError(reason) && reason.code === 'workspaces.not_found') {
    return 'This workspace could not be found.';
  }
  if (isNixApiError(reason) && reason.status === 404) {
    return 'This version of the application asked for a graph the server does not offer. The server may be running an older build.';
  }
  return 'The graph could not be loaded.';
}

export function useWorkspaceGraph(): WorkspaceGraphState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<GraphStatus>('loading');
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setStatus('loading');
    setError(null);

    try {
      const next = await client.query(coreWorkspaceGraph.workspaceGraph(workspaceId), {
        signal: controller.signal,
        forceRefresh: true,
      });
      if (controller.signal.aborted || activeLoad.current !== controller) return;
      setGraph(next);
      setStatus('ready');
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return;
      setGraph(null);
      setError(graphError(reason));
      setStatus('error');
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [client, workspaceId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      activeLoad.current?.abort();
    };
  }, [load]);

  return { status, graph, error, reload: load };
}
