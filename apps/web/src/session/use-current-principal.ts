import type { CurrentPrincipalContract } from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { useAuth } from '../auth/auth-provider';

/**
 * The signed-in caller, from `GET /api/v1/me`.
 *
 * **Fetched rather than decoded from the token, and that is the whole reason this exists.** Roles
 * live in the database and never in tokens, so whether somebody is a tenant administrator cannot
 * be read out of the OIDC profile the browser already holds - it has to be asked, and the answer
 * is only as old as the request.
 *
 * The flag it carries decides what the profile menu offers. It grants nothing: every
 * administrative endpoint asks the database the same question for itself, so a client that flipped
 * the flag in a debugger would gain a menu entry and no capability at all.
 */

const CurrentPrincipalSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  isTenantAdministrator: z.boolean(),
});

export type CurrentPrincipal = z.infer<typeof CurrentPrincipalSchema>;

/**
 * The compile-time tie to the generated contract.
 *
 * Same idiom `packages/api-client/src/schemas/item.ts` and `views/core/container-model.ts` use: if
 * Core renames or retypes a field on `CurrentPrincipalResponse`, this line stops compiling here
 * rather than the profile menu silently rendering blank.
 */
const _currentPrincipalContract =
  CurrentPrincipalSchema satisfies z.ZodType<CurrentPrincipalContract>;
void _currentPrincipalContract;

export type PrincipalStatus = 'loading' | 'ready' | 'error';

export interface CurrentPrincipalState {
  readonly status: PrincipalStatus;
  readonly principal: CurrentPrincipal | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export function useCurrentPrincipal(): CurrentPrincipalState {
  const { getAccessToken } = useAuth();

  const [status, setStatus] = useState<PrincipalStatus>('loading');
  const [principal, setPrincipal] = useState<CurrentPrincipal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch('/api/v1/me', {
        headers: {
          accept: 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      });

      if (!response.ok) {
        setError(`Your profile could not be loaded (${String(response.status)}).`);
        setStatus('error');
        return;
      }

      const parsed = CurrentPrincipalSchema.safeParse(await response.json());
      if (!parsed.success) {
        // A parse failure is telemetry, not a silent fallback: it means the contract moved and
        // this build did not, which is worth knowing about rather than papering over.
        console.warn('The profile response did not match the contract:', parsed.error.message);
        setError('Your profile could not be read.');
        setStatus('error');
        return;
      }

      setPrincipal(parsed.data);
      setStatus('ready');
    } catch {
      setError('Core could not be reached.');
      setStatus('error');
    }
  }, [getAccessToken]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, principal, error, reload: load };
}
