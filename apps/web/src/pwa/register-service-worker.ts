let registration: ServiceWorkerRegistration | undefined;
const listeners = new Set<() => void>();
export function getWaitingWorker(): ServiceWorker | null {
  return registration?.waiting ?? null;
}
export function subscribeToWorker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(): void {
  for (const listener of listeners) listener();
}

/** Register without forcing an update into an editor that may have unsynced work. */
export function registerServiceWorker(): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  let disposed = false;
  let cleanupRegistration = (): void => undefined;
  const register = (): void => {
    void navigator.serviceWorker
      .register('/service-worker.js')
      .then((value) => {
        if (disposed) return;
        registration = value;
        changed();
        const found = (): void => {
          const worker = value.installing;
          worker?.addEventListener('statechange', changed);
        };
        value.addEventListener('updatefound', found);
        const check = (): void => {
          if (document.visibilityState === 'visible' && navigator.onLine)
            void value.update().catch(() => undefined);
        };
        document.addEventListener('visibilitychange', check);
        cleanupRegistration = () => {
          value.removeEventListener('updatefound', found);
          document.removeEventListener('visibilitychange', check);
        };
      })
      .catch((error: unknown) => {
        console.warn('The Nix app installer could not be registered.', error);
      });
  };
  if (document.readyState === 'complete') register();
  else globalThis.addEventListener('load', register, { once: true });
  return () => {
    disposed = true;
    cleanupRegistration();
    globalThis.removeEventListener('load', register);
  };
}
