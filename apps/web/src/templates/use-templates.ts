import {
  cacheKeyToString,
  isCanceledError,
  isNixApiError,
  templates as coreTemplates,
  type CacheEntry,
  type TemplateCatalog,
  type TemplateSummary,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useApiClient } from '../api/api-client-provider';

export type TemplateLibraryStatus = 'loading' | 'ready' | 'error';

function readWorkspaceId(): string {
  const configured: unknown = import.meta.env.VITE_WORKSPACE_ID;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : 'a1000000-0000-4000-8000-000000000001';
}

export const TEMPLATE_WORKSPACE_ID = readWorkspaceId();
const TEMPLATE_LIBRARY_KEY = coreTemplates.templateLibraryKey(TEMPLATE_WORKSPACE_ID);
const TEMPLATE_LIBRARY_KEY_ID = cacheKeyToString(TEMPLATE_LIBRARY_KEY);
const TEMPLATE_LIBRARY_ENDPOINT = coreTemplates.listTemplates(TEMPLATE_WORKSPACE_ID);

function noCachedTemplateLibrary(): CacheEntry<TemplateCatalog> | undefined {
  return undefined;
}

export function templateFailure(error: unknown, fallback: string): string {
  if (isNixApiError(error)) {
    return error.detail ?? fallback;
  }
  return fallback;
}

export interface TemplateLibrary {
  readonly status: TemplateLibraryStatus;
  readonly templates: readonly TemplateSummary[];
  readonly error: string | null;
  readonly capabilities: { readonly canManage: boolean };
  readonly reload: () => void;
}

export function useTemplates(): TemplateLibrary {
  const client = useApiClient();
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const handledReload = useRef(-1);

  // Stable identities are required by useSyncExternalStore; changing either function would
  // unsubscribe and resubscribe on every render.
  const subscribe = useCallback(
    (notify: () => void) =>
      client.cache.subscribe((changedKey) => {
        if (cacheKeyToString(changedKey) === TEMPLATE_LIBRARY_KEY_ID) notify();
      }),
    [client],
  );
  const getSnapshot = useCallback(
    () => client.cache.peek<TemplateCatalog>(TEMPLATE_LIBRARY_KEY),
    [client],
  );
  const cached = useSyncExternalStore(subscribe, getSnapshot, noCachedTemplateLibrary);

  useEffect(() => {
    const explicitReload = handledReload.current !== reloadKey;
    handledReload.current = reloadKey;
    if (!explicitReload && cached !== undefined && !cached.stale) return;

    const controller = new AbortController();

    void client
      .query(TEMPLATE_LIBRARY_ENDPOINT, {
        signal: controller.signal,
        forceRefresh: explicitReload || cached?.stale === true,
      })
      .then(() => {
        setError(null);
      })
      .catch((reason: unknown) => {
        if (isCanceledError(reason)) return;
        setError(templateFailure(reason, 'Templates could not be loaded. Check the connection.'));
      });

    return () => {
      controller.abort();
    };
  }, [cached, client, reloadKey]);

  // Stable because consumers may use reload as an effect or event dependency.
  const reload = useCallback(() => {
    setError(null);
    setReloadKey((current) => current + 1);
  }, []);

  return {
    status: error !== null ? 'error' : cached === undefined ? 'loading' : 'ready',
    templates: cached?.data.templates ?? [],
    error,
    capabilities: cached?.data.capabilities ?? { canManage: false },
    reload,
  };
}
