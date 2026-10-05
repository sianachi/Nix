import {
  isCanceledError,
  isNixApiError,
  workspaces,
  type DailyNoteSettings,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';

export interface DailyNoteSettingsState {
  readonly saved: DailyNoteSettings | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  /** The server refused a save as not-found, which for this resource means no permission. */
  readonly forbidden: boolean;
  readonly save: (value: DailyNoteSettings) => Promise<boolean>;
}

// Cancellation can change while a request is awaiting I/O.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Loads and saves one workspace's daily-note settings, following the shape of
 * `use-notification-preferences.ts`. Unlike that document these settings are not revisioned, so
 * there is no conflict branch; the failures worth telling apart are a refused save (the server
 * answers 404 to anyone who may read but not change) and a rejected value (422 with a detail).
 */
export function useDailyNoteSettings(workspaceId: string): DailyNoteSettingsState {
  const client = useApiClient();
  const [saved, setSaved] = useState<DailyNoteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const savingRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await client.query(workspaces.dailyNoteSettings(workspaceId), {
          signal,
          forceRefresh: true,
        });
        if (isAborted(signal)) return;
        setSaved(response);
      } catch (cause) {
        if (isAborted(signal) || isCanceledError(cause)) return;
        setError('Daily note settings could not be loaded. Check your connection and try again.');
      } finally {
        if (!isAborted(signal)) setLoading(false);
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Another workspace's settings must not linger on screen while this one loads.
    queueMicrotask(() => {
      if (isAborted(controller.signal)) return;
      setSaved(null);
      setForbidden(false);
      void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  async function save(value: DailyNoteSettings): Promise<boolean> {
    const controller = lifetime.current;
    if (saved === null || savingRef.current || !controller || isAborted(controller.signal)) {
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await client.execute(workspaces.saveDailyNoteSettings(workspaceId, value), {
        signal: controller.signal,
      });
      if (isAborted(controller.signal)) return false;
      setSaved(response);
      return true;
    } catch (cause) {
      if (isAborted(controller.signal) || isCanceledError(cause)) return false;
      if (isNixApiError(cause) && cause.status === 404) {
        setForbidden(true);
        setError('You do not have permission to change this workspace’s daily notes.');
        return false;
      }
      setError(
        isNixApiError(cause) && cause.status === 422 && cause.detail !== undefined
          ? cause.detail
          : 'The save could not be confirmed. Reload the page before trying again.',
      );
      return false;
    } finally {
      savingRef.current = false;
      if (!isAborted(controller.signal)) setSaving(false);
    }
  }

  return { saved, loading, saving, error, forbidden, save };
}
