/** Registers the installed-app lifecycle on production origins that support service workers. */
export function registerServiceWorker(): () => void {
  if (!('serviceWorker' in navigator)) {
    return () => undefined;
  }

  const register = (): void => {
    void navigator.serviceWorker.register('/service-worker.js').catch((error: unknown) => {
      // Installation is an enhancement. Keep the web application usable and leave a diagnostic
      // for operators when a proxy or content policy blocks the worker.
      console.warn('The Nix app installer could not be registered.', error);
    });
  };

  if (document.readyState === 'complete') {
    register();
    return () => undefined;
  }

  globalThis.addEventListener('load', register, { once: true });
  return () => {
    globalThis.removeEventListener('load', register);
  };
}
