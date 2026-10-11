import { createHash, createHmac } from 'node:crypto';

/**
 * Header-signed AWS Signature Version 4 for S3, for the serving process's reads.
 *
 * The worker never signs anything: Core hands it presigned capabilities. The serving process holds
 * a read-only credential of its own and signs GET and HEAD with it, so this is the one place in
 * `apps/sites` that touches a secret key. Ported from `scripts/sigv4-presign.mts` (which presigns
 * a query string) to the Authorization-header form, which keeps the signature out of the URL.
 */

export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Extra headers to sign. `host`, `x-amz-date` and `x-amz-content-sha256` are added here. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadSha256?: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly now: Date;
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** The request headers to send: the ones given, plus date, payload hash and `authorization`. */
export function signRequest(input: SignInput): Record<string, string> {
  const payload = input.payloadSha256 ?? EMPTY_PAYLOAD_SHA256;
  const timestamp = input.now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim();
  }
  headers.host = input.url.host;
  headers['x-amz-date'] = timestamp;
  headers['x-amz-content-sha256'] = payload;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers[name] ?? ''}\n`).join('');

  const canonicalPath = input.url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payload,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretKey}`, day), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const sendable = Object.entries(headers).filter(([name]) => name !== 'host');
  return {
    ...Object.fromEntries(sendable),
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
