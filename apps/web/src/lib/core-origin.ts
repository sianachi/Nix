import { Capacitor } from '@capacitor/core';
import { z } from 'zod';

export function parseCoreOrigin(value: unknown): string {
  const parsed = new URL(z.string().min(1).parse(value));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('The Nix server must be one HTTPS origin, or loopback HTTP for development.');
  return parsed.origin;
}
export function coreOrigin(): string {
  return Capacitor.isNativePlatform()
    ? parseCoreOrigin(import.meta.env.VITE_NIX_CORE_ORIGIN ?? 'https://nix.urutech.org')
    : globalThis.location.origin;
}
export function coreRequestUrl(
  input: string,
  localOrigin = globalThis.location.href,
  serverOrigin = coreOrigin(),
): string {
  const local = new URL(localOrigin);
  const url = new URL(input, local);
  if (
    url.protocol === local.protocol &&
    url.host === local.host &&
    /^\/(?:api|auth|collab)(?:\/|$)/u.test(url.pathname)
  )
    return `${serverOrigin}${url.pathname}${url.search}`;
  return url.href;
}
export function collaborationUrl(path: string, origin = coreOrigin()): string {
  const url = new URL(path, origin);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new Error('Collaboration requires an HTTP or WebSocket address.');
  return url.href;
}
export function installMobileTransport(): void {
  if (!Capacitor.isNativePlatform()) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = coreRequestUrl(input instanceof Request ? input.url : String(input));
    return nativeFetch(input instanceof Request ? new Request(url, input) : url, init);
  };
}
