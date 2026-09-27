import { isCanceledError, pets, type PetConnection } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../api/api-client-provider';
import type { PetConversationMode } from './device-preferences';

/** How often the conversation is re-read while open. `L4` (after `L1`-`L3` merge) swaps this
 * fixed interval for `pets.watchRuntime` long-polling; every caller of this hook keeps working
 * unchanged when that happens, because the loop lives here and nowhere else. */
const READ_POLL_MS = 3000;

export interface PetSendInput {
  readonly text: string;
  readonly model: string;
  readonly workspaceAccess: boolean;
  readonly itemId?: string;
  readonly sharedText?: string;
}

export interface UsePetRuntimeResult {
  readonly runtime: PetConnection | null;
  readonly models: NonNullable<PetConnection['models']>;
  readonly error: string;
  readonly busy: boolean;
  /** Applies a newer snapshot received elsewhere (a tool claim or result round trip). */
  readonly setRuntime: (value: PetConnection) => void;
  /** Call whenever the draft that will become the next `send` changes, so a retried send of an
   * *edited* draft never reuses the request id of whatever was last attempted; an unedited retry
   * (a double click, a resend after a failed request) keeps the same id on purpose. */
  readonly regenerateRequestId: () => void;
  readonly send: (input: PetSendInput) => Promise<boolean>;
  readonly interrupt: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Owns the companion runtime's connection: the read poll loop, model discovery, and every
 * mutation against it (`send`, `interrupt`, `reset`, `reload`). No component outside this hook
 * may call `pets.runtime({operation:'read'})` - see `pet-companion.tsx`.
 *
 * The request id behind `send` stays fixed until either a send succeeds or the caller calls
 * `regenerateRequestId` (wired to the composer's own change handler), so a retried send of an
 * unedited draft reaches the worker as the same request, while a retry of an edited draft is a
 * new one.
 */
export function usePetRuntime(
  workspaceId: string,
  petId: string,
  mode: PetConversationMode,
): UsePetRuntimeResult {
  const client = useApiClient();
  const [runtime, setRuntimeState] = useState<PetConnection | null>(null);
  const [models, setModels] = useState<NonNullable<PetConnection['models']>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    void client
      .execute(pets.runtime({ operation: 'models', mode }), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setModels(value.models ?? []);
      })
      .catch(() => {
        /* The provider default remains available if model discovery fails. */
      });
    const poll = async () => {
      try {
        const result = await client.execute(
          pets.runtime({ operation: 'read', workspaceId, petId, mode }),
          { signal: controller.signal },
        );
        if (!isAborted(controller.signal)) setRuntimeState(result);
      } catch (cause) {
        if (!isCanceledError(cause) && !isAborted(controller.signal))
          setError('Conversation could not be loaded. Check your connection and try again.');
      }
      if (!isAborted(controller.signal))
        timer = setTimeout(() => {
          void poll();
        }, READ_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, workspaceId, petId, mode]);

  const command = useCallback(
    async (operation: 'send' | 'interrupt' | 'reset' | 'read', input?: PetSendInput) => {
      const controller = lifetime.current;
      if (busy || !controller || isAborted(controller.signal)) return false;
      setBusy(true);
      setError('');
      try {
        const result = await client.execute(
          pets.runtime({
            operation,
            workspaceId,
            petId,
            mode,
            ...(operation === 'send' && input
              ? {
                  requestId: requestId.current,
                  text: input.text,
                  model: input.model,
                  workspaceAccess: input.workspaceAccess,
                  ...(input.itemId
                    ? { itemId: input.itemId, sharedText: input.sharedText ?? '' }
                    : {}),
                }
              : {}),
          }),
          { signal: controller.signal },
        );
        if (isAborted(controller.signal)) return false;
        setRuntimeState(result);
        if (operation === 'send') requestId.current = crypto.randomUUID();
        return true;
      } catch (cause) {
        if (!isCanceledError(cause) && !isAborted(controller.signal))
          setError(
            operation === 'send'
              ? 'The request could not be confirmed. Try again; your draft is preserved.'
              : 'The request could not be confirmed. Try again.',
          );
        return false;
      } finally {
        if (!isAborted(controller.signal)) setBusy(false);
      }
    },
    [busy, client, workspaceId, petId, mode],
  );

  return {
    runtime,
    models,
    error,
    busy,
    setRuntime: setRuntimeState,
    regenerateRequestId: () => {
      requestId.current = crypto.randomUUID();
    },
    send: (input) => command('send', input),
    interrupt: async () => {
      await command('interrupt');
    },
    reset: async () => {
      await command('reset');
    },
    reload: async () => {
      await command('read');
    },
  };
}
