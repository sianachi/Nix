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
        // `getAccessToken` asks the OIDC manager at call time. If a silent renewal has completed,
        // this is the replacement token; if it has not, the original 401 remains the honest answer.
        refreshAccessToken: getAccessToken,
      },
    }),
  );

  return <ApiClientContext value={client}>{children}</ApiClientContext>;
}
