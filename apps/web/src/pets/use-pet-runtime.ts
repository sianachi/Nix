import { isCanceledError, pets, type PetConnection } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../api/api-client-provider';
import type { PetConversationMode } from './device-preferences';

/** The floor on how often the watch loop starts a new request, whether that request is the
 * next iteration of a normal poll or the very first one after a pause. */
const MIN_REQUEST_GAP_MS = 250;
/** A watch that answers with an unchanged revision faster than `MIN_REQUEST_GAP_MS` is not a
 * real long poll - the worker returned immediately rather than waiting on a change - so the
 * loop backs off by this much rather than hammering it in a tight cycle. */
const IMMEDIATE_UNCHANGED_DELAY_MS = 1000;
/** Backoff after consecutive watch failures: 1s, 2s, 4s, then capped at 10s for every failure
 * after that. A worker 429 arrives as an ordinary error here - it gets no special case. */
const BACKOFF_MS = [1000, 2000, 4000, 10000] as const;
/** How long the loop waits, while the panel is closed and there is nothing worth watching for,
 * before it re-checks whether that is still true. Not a network request - just a local check -
 * so this does not count against "do not poll a closed, idle panel". */
const IDLE_RECHECK_MS = 300;

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

function backoffDelay(failures: number): number {
  const index = Math.min(Math.max(0, failures - 1), BACKOFF_MS.length - 1);
  return BACKOFF_MS[index] ?? 10000;
}

/** Resolves after `ms`, or immediately if the signal is already aborted / becomes aborted while
 * waiting - a wait this hook is stuck in must never outlive the component. `wake`, when given,
 * also resolves the wait the moment it fires - what lets the idle-panel recheck below react to
 * the panel opening right away, rather than up to `IDLE_RECHECK_MS` late. */
function sleep(ms: number, signal: AbortSignal, wake?: EventTarget): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      wake?.removeEventListener('wake', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
    wake?.addEventListener('wake', finish, { once: true });
  });
}

/** Resolves immediately when the document is already visible; otherwise waits for the next
 * `visibilitychange` that makes it visible. This is both what pauses the watch loop while the
 * tab is hidden, and what makes the next iteration fire right away on becoming visible, rather
 * than owing the rest of whatever throttle or backoff delay it was mid-wait on. */
function waitUntilVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted || document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      document.removeEventListener('visibilitychange', onVisible);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') finish();
    };
    document.addEventListener('visibilitychange', onVisible);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function hasPendingTool(runtime: PetConnection | null): boolean {
  return (runtime?.tools ?? []).some((tool) => tool.status === 'pending');
}

/**
 * Owns the companion runtime's connection: the watch loop, model discovery, and every mutation
 * against it (`send`, `interrupt`, `reset`, `reload`). No component outside this hook may call
 * `pets.watchRuntime` or `pets.runtime({operation:'read'})` directly - see `pet-companion.tsx`.
 *
 * `panelOpen` governs whether the watch loop keeps running while the caller's panel is closed:
 * it always runs while open, and while closed it keeps running only for as long as the last
 * known state is `thinking` or a tool is `pending` - never against an idle, closed panel.
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
  panelOpen: boolean,
): UsePetRuntimeResult {
  const client = useApiClient();
  const [runtime, setRuntimeState] = useState<PetConnection | null>(null);
  const [models, setModels] = useState<NonNullable<PetConnection['models']>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const lifetime = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const runtimeRef = useRef<PetConnection | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const wake = useRef(new EventTarget());
  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (panelOpen) wake.current.dispatchEvent(new Event('wake'));
  }, [panelOpen]);

  /** Applies a snapshot (from a watch or a mutation) only if its revision is not older than the
   * one already applied - a stale response, arriving after a newer one, must never overwrite it. */
  const applyIfNewer = useCallback((value: PetConnection) => {
    if (value.revision < revision.current) return false;
    revision.current = value.revision;
    runtimeRef.current = value;
    setRuntimeState(value);
    return true;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    revision.current = 0;
    runtimeRef.current = null;
    void client
      .execute(pets.runtime({ operation: 'models', mode }), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setModels(value.models ?? []);
      })
      .catch(() => {
        /* The provider default remains available if model discovery fails. */
      });

    let failures = 0;
    let nextEarliestStart = 0;

    // Nothing is known yet the first time this runs (`runtimeRef.current` is still `null`) - that
    // counts as "must watch", not "idle", so a panel that starts closed still learns the actual
    // state at least once instead of never fetching at all.
    const shouldWatch = () =>
      panelOpenRef.current ||
      runtimeRef.current === null ||
      runtimeRef.current.state === 'thinking' ||
      hasPendingTool(runtimeRef.current);

    const watch = async () => {
      while (!isAborted(controller.signal)) {
        if (!shouldWatch()) {
          await sleep(IDLE_RECHECK_MS, controller.signal, wake.current);
          continue;
        }
        await waitUntilVisible(controller.signal);
        if (isAborted(controller.signal)) break;
        if (!shouldWatch()) continue;
        const now = Date.now();
        if (now < nextEarliestStart) await sleep(nextEarliestStart - now, controller.signal);
        if (isAborted(controller.signal)) break;
        const requestStart = Date.now();
        nextEarliestStart = requestStart + MIN_REQUEST_GAP_MS;
        try {
          // `forceRefresh` is what keeps this an actual long poll rather than a cache read: two
          // watches in a row commonly carry the *same* `after` (nothing changed yet), and the
          // generic query cache would otherwise serve the first response straight back for up
          // to 30s without ever reaching the worker again.
          const result = await client.query(
            pets.watchRuntime({ workspaceId, petId, mode, after: revision.current }),
            { signal: controller.signal, forceRefresh: true },
          );
          if (isAborted(controller.signal)) break;
          const elapsed = Date.now() - requestStart;
          const unchanged = result.revision <= revision.current;
          applyIfNewer(result);
          failures = 0;
          setError('');
          if (unchanged && elapsed < MIN_REQUEST_GAP_MS)
            nextEarliestStart = Date.now() + IMMEDIATE_UNCHANGED_DELAY_MS;
        } catch (cause) {
          if (isCanceledError(cause) || isAborted(controller.signal)) break;
          failures += 1;
          if (failures >= 2)
            setError('Conversation could not be loaded. Check your connection and try again.');
          nextEarliestStart = Date.now() + backoffDelay(failures);
        }
      }
    };
    void watch();
    return () => {
      controller.abort();
    };
  }, [client, workspaceId, petId, mode, applyIfNewer]);

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
        applyIfNewer(result);
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
    [busy, client, workspaceId, petId, mode, applyIfNewer],
  );

  return {
    runtime,
    models,
    error,
    busy,
    setRuntime: applyIfNewer,
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
