import { createHash, createHmac } from 'node:crypto';

const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_REGION_LENGTH = 128;
const MAX_BUCKET_LENGTH = 255;
const MAX_ACCESS_KEY_LENGTH = 256;
const MAX_SECRET_KEY_LENGTH = 1_024;
const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export interface BucketPutPresignOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly expiresSeconds: number;
  readonly now?: () => Date;
}

export function presignBucketPut(options: BucketPutPresignOptions): string {
  const endpointValue = boundedValue(
    'Object-store endpoint',
    options.endpoint,
    MAX_ENDPOINT_LENGTH,
  );
  const region = boundedValue('Object-store region', options.region, MAX_REGION_LENGTH);
  const bucket = boundedValue('Object-store bucket', options.bucket, MAX_BUCKET_LENGTH);
  const accessKey = boundedValue(
    'Object-store access key',
    options.accessKey,
    MAX_ACCESS_KEY_LENGTH,
  );
  const secretKey = boundedValue(
    'Object-store secret key',
    options.secretKey,
    MAX_SECRET_KEY_LENGTH,
  );
  if (
    !Number.isSafeInteger(options.expiresSeconds) ||
    options.expiresSeconds < 1 ||
    options.expiresSeconds > MAX_EXPIRY_SECONDS
  ) {
    throw new Error(
      `Object-store capability expiry must be an integer from 1 to ${String(MAX_EXPIRY_SECONDS)} seconds.`,
    );
  }

  const endpoint = parseEndpoint(endpointValue);
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Object-store signing time is invalid.');

  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const path = [...endpoint.pathname.split('/').filter((part) => part !== ''), bucket]
    .map((part) => uriEncode(decodePathSegment(part)))
    .join('/');
  endpoint.pathname = `/${path}`;

  const parameters: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(options.expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalRequest = [
    'PUT',
    endpoint.pathname,
    canonicalQuery(parameters),
    `host:${endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = createHmac('sha256', `AWS4${secretKey}`).update(day).digest();
  const regionKey = createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  parameters['X-Amz-Signature'] = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  endpoint.search = canonicalQuery(parameters);
  return endpoint.toString();
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Object-store endpoint must be an absolute URL.');
  }
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('Object-store endpoint must not contain credentials.');
  }
  if (endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('Object-store endpoint must not contain a query or fragment.');
  }
  const isLoopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLoopback)) {
    throw new Error('Object-store endpoint must use HTTPS outside local development.');
  }
  return endpoint;
}

function boundedValue(label: string, value: string, maximumLength: number): string {
  if (value.length === 0) throw new Error(`${label} must not be empty.`);
  if (value.length > maximumLength) {
    throw new Error(`${label} must not exceed ${String(maximumLength)} characters.`);
  }
  return value;
}

function canonicalQuery(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('Object-store endpoint contains invalid path encoding.');
  }
}
