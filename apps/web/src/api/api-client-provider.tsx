import { createNixClient, type NixClient } from '@nix/api-client';
import { createContext, use, useState, type ReactNode } from 'react';

import { useAuth } from '../auth/auth-provider';

const ApiClientContext = createContext<NixClient | null>(null);

export function useApiClient(): NixClient {
  const client = use(ApiClientContext);
  if (client === null) {
    throw new Error('useApiClient was called outside ApiClientProvider.');
  }
  return client;
}

/**
 * The current client, or null when there is none.
 *
 * A control that can *sometimes* reach Core - an image property's upload capability, say - calls
 * this instead of {@link useApiClient}, so a render with no provider above it (most component
 * tests render a leaf directly, without the app's own provider tree) can turn that capability off
 * rather than throw.
 */
export function useOptionalApiClient(): NixClient | null {
  return use(ApiClientContext);
}

export function ApiClientProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { getAccessToken } = useAuth();
  const [client] = useState(() =>
    createNixClient({
      baseUrl: globalThis.location.origin,
      tokens: {
        getAccessToken,
        // Core renews only its own short-lived bearer token from the HttpOnly browser session;
        // provider tokens never enter this client or JavaScript at all.
        refreshAccessToken: getAccessToken,
      },
    }),
  );

  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}

/** Supplies a deterministic client to isolated component stories and interaction tests. */
export function ApiClientOverrideProvider({
  client,
  children,
}: {
  readonly client: NixClient;
  readonly children: ReactNode;
}): ReactNode {
  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}
