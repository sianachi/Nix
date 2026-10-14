import { useEffect } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { hydrateUiSettings } from '../lib/ui-settings-sync';

/** Reads the account's synced interface settings once the shell has a client. */
export function useUiSettingsSync(): void {
  const client = useApiClient();
  useEffect(() => {
    void hydrateUiSettings(client);
  }, [client]);
}
