import { Button, Dialog, Text } from '@nix/ui';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushPendingWork } from '../lib/pending-work';
import { getWaitingWorker, subscribeToWorker } from './register-service-worker';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
// Capture before the session and workspace requests complete.
if (typeof window !== 'undefined')
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    for (const listener of installListeners) listener();
  });
function subscribeInstall(listener: () => void): () => void {
  installListeners.add(listener);
  return () => {
    installListeners.delete(listener);
  };
}

export function PwaControls(): ReactNode {
  const waiting = useSyncExternalStore(subscribeToWorker, getWaitingWorker, () => null);
  const prompt = useSyncExternalStore(
    subscribeInstall,
    () => installPrompt,
    () => null,
  );
  const [offline, setOffline] = useState(!navigator.onLine);
  const [help, setHelp] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(
    () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && navigator.standalone === true),
  );
  useEffect(() => {
    const online = (): void => {
      setOffline(false);
    };
    const offlineNow = (): void => {
      setOffline(true);
    };
    const installedNow = (): void => {
      setInstalled(true);
      installPrompt = null;
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineNow);
    window.addEventListener('appinstalled', installedNow);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offlineNow);
      window.removeEventListener('appinstalled', installedNow);
    };
  }, []);
  useEffect(() => {
    const updateTheme = (): void => {
      const app = document.querySelector('#root > div');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (app && meta) meta.setAttribute('content', getComputedStyle(app).backgroundColor);
    };
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', updateTheme);
    updateTheme();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', updateTheme);
    };
  }, []);
  async function update(): Promise<void> {
    if (!waiting || updating) return;
    setUpdating(true);
    setError(null);
    try {
      await flushPendingWork();
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          window.location.reload();
        },
        { once: true },
      );
      waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    } catch {
      setError('Finish syncing your edits before updating. Your current app is still open.');
      setUpdating(false);
    }
  }
  return (
    <>
      {offline || waiting || (!installed && !dismissed) ? (
        <aside
          aria-label="App status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-divider bg-background px-3 py-1"
        >
          {offline ? (
            <Text variant="caption" role="status">
              Offline. Reconnect to open documents and sync changes.
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              {waiting ? 'An update is ready.' : 'Keep Nix on your home screen.'}
            </Text>
          )}
          {waiting ? (
            <Button
              variant="ghost"
              disabled={updating || offline}
              onClick={() => {
                void update();
              }}
            >
              {updating ? 'Preparing update…' : 'Update Nix'}
            </Button>
          ) : !installed ? (
            <Button
              variant="ghost"
              onClick={() => {
                if (prompt)
                  void prompt
                    .prompt()
                    .then(() => prompt.userChoice)
                    .then((choice) => {
                      installPrompt = null;
                      for (const listener of installListeners) listener();
                      if (choice.outcome === 'accepted') setInstalled(true);
                    })
                    .catch(() => {
                      setHelp(true);
                    });
                else setHelp(true);
              }}
            >
              Install
            </Button>
          ) : null}
          {!installed && !waiting && !offline ? (
            <Button
              variant="ghost"
              onClick={() => {
                setDismissed(true);
              }}
            >
              Not now
            </Button>
          ) : null}
          {error ? (
            <Text variant="caption" role="alert">
              {error}
            </Text>
          ) : null}
        </aside>
      ) : null}
      <Dialog
        open={help}
        onClose={() => {
          setHelp(false);
        }}
        title="Install Nix"
      >
        <Text as="p" variant="body">
          On iPhone or iPad, open the browser’s Share menu, choose Add to Home Screen, and keep Open
          as Web App enabled if offered.
        </Text>
        <Text as="p" variant="body">
          On Android or desktop, open the browser menu and choose Install app or Add to Home screen.
          Installation needs a secure HTTPS connection.
        </Text>
        <Button
          onClick={() => {
            setHelp(false);
          }}
        >
          Done
        </Button>
      </Dialog>
    </>
  );
}
