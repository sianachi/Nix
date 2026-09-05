import { z } from 'zod';
import { useEffect, useRef } from 'react';

/** One same-address history entry lets the browser Back gesture dismiss a shell overlay. */
export function useBackDismiss(open: boolean, dismiss: () => void): void {
  const callback = useRef(dismiss);
  useEffect(() => {
    callback.current = dismiss;
  }, [dismiss]);
  useEffect(() => {
    if (!open) return;
    const marker = crypto.randomUUID();
    const originalUrl = window.location.href;
    window.history.pushState({ ...window.history.state, nixOverlay: marker }, '', originalUrl);
    const back = (): void => {
      callback.current();
    };
    window.addEventListener('popstate', back, { once: true });
    return () => {
      window.removeEventListener('popstate', back);
      if (
        z.object({ nixOverlay: z.string() }).safeParse(window.history.state).data?.nixOverlay ===
          marker &&
        window.location.href === originalUrl
      )
        window.history.back();
    };
  }, [open]);
}
