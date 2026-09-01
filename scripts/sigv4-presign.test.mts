import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createDevBucketCorsRequest,
  DEV_BUCKET_CORS_POLICY,
  prepareDevObjectStore,
} from './ensure-dev-object-store.mts';
import { presignBucketPut } from './sigv4-presign.mts';

const validOptions = {
  endpoint: 'http://localhost:7070/base',
  region: 'us-east-1',
  bucket: 'nix-worker-jobs',
  accessKey: 'test-access',
  secretKey: 'test-secret',
  expiresSeconds: 60,
  now: () => new Date('2026-09-01T12:34:56.000Z'),
};

test('presigns the existing path-style bucket PUT deterministically', () => {
  assert.equal(
    presignBucketPut(validOptions),
    'http://localhost:7070/base/nix-worker-jobs?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test-access%2F20260901%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260901T123456Z&X-Amz-Expires=60&X-Amz-Signature=aeca0975740aa462393568e3ba5380f8d27dfd6c922228e6e88c6d991a4cff3a&X-Amz-SignedHeaders=host',
  );
});

test('preserves nested and escaped endpoint path segments', () => {
  const result = presignBucketPut({
    ...validOptions,
    endpoint: 'https://objects.example.test/storage/team%20one',
  });

  assert.equal(new URL(result).pathname, '/storage/team%20one/nix-worker-jobs');
  assert.doesNotMatch(new URL(result).pathname, /storage%2Fteam/u);
  assert.doesNotMatch(new URL(result).pathname, /%2520/u);
});

test('keeps secrets out of the presigned URL', () => {
  const result = presignBucketPut(validOptions);

  assert.doesNotMatch(result, /test-secret/);
});

test('permits HTTP only for the supported loopback endpoints', () => {
  assert.doesNotThrow(() => presignBucketPut(validOptions));
  assert.doesNotThrow(() =>
    presignBucketPut({ ...validOptions, endpoint: 'http://127.0.0.1:7070' }),
  );
  assert.throws(
    () => presignBucketPut({ ...validOptions, endpoint: 'http://objects.example.test' }),
    /must use HTTPS/,
  );
});

test('rejects ambiguous endpoints and out-of-range capabilities', () => {
  assert.throws(
    () => presignBucketPut({ ...validOptions, endpoint: 'https://user@example.test' }),
    /must not contain credentials/,
  );
  assert.throws(
    () => presignBucketPut({ ...validOptions, endpoint: 'https://example.test?mode=bootstrap' }),
    /must not contain a query or fragment/,
  );
  assert.throws(
    () => presignBucketPut({ ...validOptions, expiresSeconds: 604_801 }),
    /expiry must be an integer from 1 to 604800 seconds/,
  );
  assert.throws(
    () => presignBucketPut({ ...validOptions, accessKey: 'a'.repeat(257) }),
    /access key must not exceed 256 characters/,
  );
});

test('the bootstrap no longer imports or reads Media configuration', async () => {
  const source = await readFile(new URL('./ensure-dev-object-store.mts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /apps\/media/);
  assert.doesNotMatch(source, /NIX_MEDIA_/);
  assert.match(source, /from '\.\/sigv4-presign\.mts'/);
});

test('signs a bounded PutBucketCors request with the required integrity headers', () => {
  const request = createDevBucketCorsRequest(validOptions, new Date('2026-09-01T12:34:56.000Z'));

  assert.equal(request.url, 'http://localhost:7070/base/nix-worker-jobs?cors=');
  assert.equal(request.body, DEV_BUCKET_CORS_POLICY);
  assert.ok(Buffer.byteLength(request.body) < 4_096);
  assert.equal(
    request.headers['content-md5'],
    createHash('md5').update(request.body).digest('base64'),
  );
  assert.equal(
    request.headers['x-amz-content-sha256'],
    createHash('sha256').update(request.body).digest('hex'),
  );
  assert.equal(request.headers['content-type'], 'application/xml');
  assert.equal(request.headers['x-amz-date'], '20260901T123456Z');
  assert.match(
    request.headers.authorization ?? '',
    /^AWS4-HMAC-SHA256 Credential=test-access\/20260901\/us-east-1\/s3\/aws4_request, SignedHeaders=content-md5;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
  );
  assert.doesNotMatch(JSON.stringify(request), /test-secret/u);
});

test('the development CORS rule admits only the browser capability surface', () => {
  const values = (element: string): string[] =>
    [...DEV_BUCKET_CORS_POLICY.matchAll(new RegExp(`<${element}>([^<]+)</${element}>`, 'gu'))]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);

  assert.deepEqual(values('AllowedOrigin'), ['http://localhost:5173', 'http://127.0.0.1:5173']);
  assert.deepEqual(values('AllowedMethod'), ['GET', 'HEAD', 'PUT']);
  assert.deepEqual(values('AllowedHeader'), [
    'content-type',
    'if-none-match',
    'x-amz-checksum-sha256',
  ]);
  assert.deepEqual(values('ExposeHeader'), ['ETag', 'x-amz-checksum-sha256']);
  assert.deepEqual(values('MaxAgeSeconds'), ['600']);
  assert.doesNotMatch(DEV_BUCKET_CORS_POLICY, /<AllowedOrigin>\*<\/AllowedOrigin>/u);
  assert.doesNotMatch(DEV_BUCKET_CORS_POLICY, /<AllowedHeader>\*<\/AllowedHeader>/u);
});

test('the bootstrap configures CORS after ensuring the bucket exists', async () => {
  const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 200 });
  };

  await prepareDevObjectStore(validOptions, request);

  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0]?.url ?? '', /[?&]cors=/u);
  assert.equal(requests[0]?.init?.method, 'PUT');
  assert.match(requests[1]?.url ?? '', /\?cors=$/u);
  assert.equal(requests[1]?.init?.method, 'PUT');
  assert.equal(requests[1]?.init?.body, DEV_BUCKET_CORS_POLICY);
  assert.equal(requests[1]?.init?.redirect, 'error');
});
