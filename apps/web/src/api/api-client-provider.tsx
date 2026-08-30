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
