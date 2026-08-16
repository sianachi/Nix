import { accessTokens, type CommandEndpoint, type QueryEndpoint } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-provider';

/**
 * The caller's personal access tokens: the list, the mint, and the revocation.
 *
 * Talks to Core directly with `fetch` rather than through `@nix/api-client`'s cache layer, for the
 * same reason `use-workspace-tree.ts` does: the client's descriptor execution wants a configured
 * `NixClient` and this needs one thing, a bearer token on each request. The *descriptors* are the
 * package's own, though - `accessTokens.listAccessTokens()` and friends carry the path, the method
 * and the response schema - so neither a URL nor a shape is restated here, and only the transport
 * changes when the app-wide client is wired.
 *
 * The token types are derived from those descriptors rather than imported by name, because the
 * package's root barrel does not yet re-export its access-token schema module the way it does
 * items and calendars. `QueryEndpoint<T>` already knows `T`; asking it is the same source of
 * truth with no second declaration to drift.
 *
 * **The list includes revoked and expired tokens, and this hook never filters them.** The server
 * returns every token the principal has issued because the list is an audit of what has been able
 * to act as this principal, and an audit that forgets is not one. Which rows are live is a display
 * question, answered per row in the section that renders them.
 *
 * **The secret appears in exactly one place**: the create outcome. It is handed to the caller and
 * never stored here, because there is nothing to refresh it from - the server keeps only a hash.
 */

type ResultOf<Endpoint> =
  Endpoint extends QueryEndpoint<infer TResult>
    ? TResult
    : Endpoint extends CommandEndpoint<infer TResult>
      ? TResult
      : never;

export type AccessTokenList = ResultOf<ReturnType<typeof accessTokens.listAccessTokens>>;
export type AccessToken = AccessTokenList['tokens'][number];
export type CreatedAccessToken = ResultOf<ReturnType<typeof accessTokens.createAccessToken>>;

export type AccessTokensStatus = 'loading' | 'ready' | 'error';

/**
 * What a create came back with: a minted token or a reason, never neither and never both.
 *
 * The same shape `use-workspace-tree.ts` gives `CreateOutcome`, for the same reason: the caller is
 * standing where the person is looking, so the refusal is returned to it rather than pushed into
 * the list-wide error at the other end of the screen.
 */
export interface CreateTokenOutcome {
  readonly created: CreatedAccessToken | null;
  readonly refusal: string | null;
}

export interface AccessTokensState {
  readonly status: AccessTokensStatus;
  readonly tokens: readonly AccessToken[];
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly create: (request: {
    readonly name: string;
    readonly scopes: readonly string[];
    readonly expiresInDays: number;
  }) => Promise<CreateTokenOutcome>;
  readonly revoke: (tokenId: string) => Promise<{ readonly refusal: string | null }>;
}

/**
 * The refusal a failed mint deserves, keyed on the problem's stable `code` rather than the status
 * alone. `tokens.limit_reached` gets a fallback sentence of its own because the person can act on
 * it - the fix is on the same screen - while both prefer the server's own account of what could
 * not mint a token, which names the faulty input.
 */
function createRefusal(status: number, problem: { code?: string; detail?: string } | null): string {
  if (problem?.code === 'tokens.limit_reached') {
    return (
      problem.detail ??
      'You already hold the most live tokens one account may. Revoke one you no longer use, then try again.'
    );
  }

  if (problem?.code === 'tokens.invalid') {
    return problem.detail ?? 'That name, scope set or expiry could not mint a token.';
  }

  return problem?.detail ?? `The token could not be created (${String(status)}).`;
}

export function useAccessTokens(): AccessTokensState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<AccessTokensStatus>('loading');
  const [tokens, setTokens] = useState<readonly AccessToken[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setStatus('loading');
      setError(null);

      const descriptor = accessTokens.listAccessTokens();

      try {
        const token = await getAccessToken();
        const response = await fetch(descriptor.path, {
          ...(signal === undefined ? {} : { signal }),
          headers: {
            accept: 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
        });

        if (!response.ok) {
          setError(`Your tokens could not be loaded (${String(response.status)}).`);
          setStatus('error');
          return;
        }

        const parsed = descriptor.schema.safeParse(await response.json());
        if (!parsed.success) {
          // A parse failure is telemetry, not a silent fallback: the contract moved and this build
          // did not, which is worth knowing about rather than papering over.
          console.warn('The token list did not match the contract:', parsed.error.message);
          setError('Your tokens could not be read.');
          setStatus('error');
          return;
        }

        setTokens(parsed.data.tokens);
        setStatus('ready');
      } catch (cause) {
        if (signal?.aborted === true) {
          return;
        }

        console.warn('The token list read failed.', cause);
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

  const create = useCallback(
    async (mint: {
      readonly name: string;
      readonly scopes: readonly string[];
      readonly expiresInDays: number;
    }): Promise<CreateTokenOutcome> => {
      const descriptor = accessTokens.createAccessToken(mint);

      try {
        const token = await getAccessToken();
        const response = await fetch(descriptor.path, {
          method: descriptor.method,
          headers: {
            'content-type': 'application/json',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify(descriptor.body),
        });

        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as {
            code?: string;
            detail?: string;
          } | null;
          return { created: null, refusal: createRefusal(response.status, problem) };
        }

        const parsed = descriptor.schema.safeParse(await response.json());
        if (!parsed.success) {
          // The token may well have been minted - the response just could not be read - so the
          // refusal says to check the list rather than claiming nothing happened.
          console.warn('The created token did not match the contract:', parsed.error.message);
          return {
            created: null,
            refusal:
              'The response could not be read. Check the list below before trying again: the token may have been created without its secret ever being shown, in which case revoke it.',
          };
        }

        return { created: parsed.data, refusal: null };
      } catch {
        return {
          created: null,
          refusal: 'The token could not be sent. Check the connection and try again.',
        };
      }
    },
    [getAccessToken],
  );

  const revoke = useCallback(
    async (tokenId: string): Promise<{ readonly refusal: string | null }> => {
      const descriptor = accessTokens.revokeAccessToken(tokenId);

      try {
        const token = await getAccessToken();
        const response = await fetch(descriptor.path, {
          method: descriptor.method,
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          return { refusal: `The token could not be revoked (${String(response.status)}).` };
        }

        return { refusal: null };
      } catch {
        return { refusal: 'The revocation could not be sent. Check the connection and try again.' };
      }
    },
    [getAccessToken],
  );

  return { status, tokens, error, reload, create, revoke };
}
