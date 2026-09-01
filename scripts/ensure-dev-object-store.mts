import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { presignBucketPut } from './sigv4-presign.mts';

const DEV_CORS_MAX_AGE_SECONDS = 600;
const PREPARE_TIMEOUT_MILLISECONDS = 30_000;
const RETRY_DELAY_MILLISECONDS = 500;

export const DEV_BUCKET_CORS_POLICY = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>http://localhost:5173</AllowedOrigin>
    <AllowedOrigin>http://127.0.0.1:5173</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <AllowedHeader>if-none-match</AllowedHeader>
    <AllowedHeader>x-amz-checksum-sha256</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-checksum-sha256</ExposeHeader>
    <MaxAgeSeconds>${String(DEV_CORS_MAX_AGE_SECONDS)}</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

export interface DevObjectStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly expiresSeconds: number;
}

export interface SignedCorsRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function createDevBucketCorsRequest(
  options: DevObjectStoreOptions,
  now: Date = new Date(),
): SignedCorsRequest {
  const bucketUrl = new URL(
    presignBucketPut({
      ...options,
      now: () => now,
    }),
  );
  bucketUrl.search = 'cors=';

  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${options.region}/s3/aws4_request`;
  const payloadHash = createHash('sha256').update(DEV_BUCKET_CORS_POLICY).digest('hex');
  const contentMd5 = createHash('md5').update(DEV_BUCKET_CORS_POLICY).digest('base64');
  const signedHeaders = 'content-md5;content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = [
    `content-md5:${contentMd5}`,
    'content-type:application/xml',
    `host:${bucketUrl.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${timestamp}`,
    '',
  ].join('\n');
  const canonicalRequest = [
    'PUT',
    bucketUrl.pathname,
    'cors=',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = createHmac('sha256', `AWS4${options.secretKey}`).update(day).digest();
  const regionKey = createHmac('sha256', dateKey).update(options.region).digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    url: bucketUrl.toString(),
    body: DEV_BUCKET_CORS_POLICY,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-md5': contentMd5,
      'content-type': 'application/xml',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
    },
  };
}

export async function prepareDevObjectStore(
  options: DevObjectStoreOptions,
  request: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + PREPARE_TIMEOUT_MILLISECONDS;
  let bucketReady = false;
  let lastFailure = '';

  while (Date.now() < deadline) {
    try {
      if (!bucketReady) {
        const bucketUrl = presignBucketPut(options);
        const response = await request(bucketUrl, { method: 'PUT' });
        const detail = response.ok ? '' : (await response.text()).slice(0, 512);
        bucketReady =
          response.ok ||
          (response.status === 409 && detail.includes('<Code>BucketAlreadyOwnedByYou</Code>'));
        if (!bucketReady) {
          lastFailure = responseFailure('bucket creation', response.status, detail);
        }
      }

      if (bucketReady) {
        const cors = createDevBucketCorsRequest(options);
        const response = await request(cors.url, {
          method: 'PUT',
          body: cors.body,
          headers: cors.headers,
          redirect: 'error',
        });
        if (response.ok) return;

        const detail = (await response.text()).slice(0, 512);
        lastFailure = responseFailure('CORS configuration', response.status, detail);
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await delay(RETRY_DELAY_MILLISECONDS);
  }

  throw new Error(
    `The local object-store bucket could not be prepared at ${new URL(options.endpoint).origin} within 30 seconds (${lastFailure}). Start the core development containers first.`,
  );
}

function responseFailure(operation: string, status: number, detail: string): string {
  return `${operation} returned HTTP ${String(status)}${detail === '' ? '' : `: ${detail}`}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  await prepareDevObjectStore({
    endpoint: required('NIX_OBJECT_STORE_ENDPOINT'),
    region: required('NIX_OBJECT_STORE_REGION'),
    bucket: required('NIX_OBJECT_STORE_BUCKET'),
    accessKey: required('NIX_OBJECT_STORE_ACCESS_KEY'),
    secretKey: required('NIX_OBJECT_STORE_SECRET_KEY'),
    expiresSeconds: 60,
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await main();
}
