import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from '../../pwa/register-service-worker';

let unregister = (): void => undefined;

afterEach(() => {
  unregister();
  unregister = () => undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the installed app lifecycle', () => {
  it('registers the same-origin worker after the page has loaded', async () => {
    const register = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    unregister = registerServiceWorker();
    globalThis.dispatchEvent(new Event('load'));

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/service-worker.js');
    });
  });

  it('does nothing when the browser has no service-worker support', () => {
    vi.stubGlobal('navigator', {});

    expect(() => {
      unregister = registerServiceWorker();
      globalThis.dispatchEvent(new Event('load'));
    }).not.toThrow();
  });

  it('leaves the web app usable and reports a refused registration', async () => {
    const refusal = new Error('blocked by policy');
    const register = vi.fn(() => Promise.reject(refusal));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    unregister = registerServiceWorker();
    globalThis.dispatchEvent(new Event('load'));

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'The Nix app installer could not be registered.',
        refusal,
      );
    });
  });
});
