import { createNixClient, health } from '@nix/api-client';
import { printResult, type OutputOptions } from '../output.ts';

function coreOrigin(value: string): string {
  const message =
    '--api-url must be an HTTP(S) origin without credentials, a path, query or fragment.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    value !== value.trim() ||
    value.length > 2048 ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error(message);
  return url.origin;
}

/** Probes public Core routes without reading a profile or acquiring any credentials. */
export async function readHealth(
  apiUrl: string,
  output: OutputOptions,
  signal?: AbortSignal,
): Promise<void> {
  const origin = coreOrigin(apiUrl);
  const client = createNixClient({
    baseUrl: origin,
    timeoutMs: 5000,
    tokens: {
      getAccessToken: () => null,
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  const [alive, status] = await Promise.all([
    client.query(health.liveness(), { forceRefresh: true, signal }),
    client.query(health.serviceStatus(), { forceRefresh: true, signal }),
  ]);
  printResult(
    {
      apiUrl: origin,
      liveness: alive.status,
      ...status,
      dependenciesChecked: false,
    },
    output,
  );
}
