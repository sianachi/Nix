export function internalCoreOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('The Core base URL must be an absolute HTTP or HTTPS origin.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('The Core base URL must be an HTTP or HTTPS origin without credentials.');
  }
  return url.origin;
}
