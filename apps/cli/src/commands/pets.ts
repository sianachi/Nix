import { createNixClient, pets } from '@nix/api-client';
import { printResult, type OutputOptions } from '../output.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

export interface PetOptions {
  readonly apiUrl?: string;
  readonly workspace?: string;
  readonly pet?: string;
  readonly message?: string;
  readonly model?: string;
  readonly workspaceTools?: boolean;
}

/** Interactive account operations require a short-lived BFF token, never expanded PAT scopes. */
export async function petCommand(
  profile: string | undefined,
  operation: string,
  options: PetOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const allowed = [
    'status',
    'connect',
    'disconnect',
    'models',
    'read',
    'send',
    'interrupt',
    'reset',
    'settings',
  ];
  if (!allowed.includes(operation))
    throw new Error(`Choose a pet operation: ${allowed.join(', ')}.`);
  const env = deps.env ?? process.env;
  const token = env.NIX_SESSION_TOKEN;
  const client =
    token && options.apiUrl
      ? createNixClient({
          baseUrl: options.apiUrl,
          tokens: {
            getAccessToken: () => Promise.resolve(token),
            refreshAccessToken: () => Promise.resolve(null),
          },
        })
      : (await resolveSession(profile, deps)).client;
  if (operation === 'settings') {
    printResult(await client.query(pets.settings()), output);
    return;
  }
  if (operation === 'send' && !options.message?.trim()) throw new Error('Provide --message.');
  if (
    ['read', 'send', 'interrupt', 'reset'].includes(operation) &&
    (!options.workspace || !options.pet)
  )
    throw new Error('Provide --workspace and --pet.');
  const value = await client.execute(
    pets.runtime({
      operation: operation as
        'status' | 'connect' | 'disconnect' | 'models' | 'read' | 'send' | 'interrupt' | 'reset',
      ...(options.workspace ? { workspaceId: options.workspace } : {}),
      ...(options.pet ? { petId: options.pet } : {}),
      text: options.message ?? '',
      model: options.model ?? '',
      workspaceAccess: options.workspaceTools ?? false,
      ...(operation === 'send' ? { requestId: crypto.randomUUID() } : {}),
    }),
  );
  printResult(value, output);
}
