import { setTimeout as delay } from 'node:timers/promises';

import { presignS3 } from '../apps/media/src/workers/storage.ts';

const endpoint = required('NIX_OBJECT_STORE_ENDPOINT', 'NIX_MEDIA_OBJECT_STORE_ENDPOINT');
const options = {
  endpoint,
  region: required('NIX_OBJECT_STORE_REGION', 'NIX_MEDIA_OBJECT_STORE_REGION'),
  bucket: required('NIX_OBJECT_STORE_BUCKET', 'NIX_MEDIA_OBJECT_STORE_BUCKET'),
  accessKey: required('NIX_OBJECT_STORE_ACCESS_KEY', 'NIX_MEDIA_OBJECT_STORE_ACCESS_KEY'),
  secretKey: required('NIX_OBJECT_STORE_SECRET_KEY', 'NIX_MEDIA_OBJECT_STORE_SECRET_KEY'),
  method: 'PUT' as const,
  key: '',
  expiresSeconds: 60,
};

const deadline = Date.now() + 30_000;
let lastFailure = '';

while (Date.now() < deadline) {
  try {
    const response = await fetch(presignS3(options), { method: 'PUT' });
    if (response.ok) process.exit(0);

    const detail = (await response.text()).slice(0, 512);
    if (response.status === 409 && detail.includes('<Code>BucketAlreadyOwnedByYou</Code>')) {
      process.exit(0);
    }
    lastFailure = `HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail}`}`;
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }

  await delay(500);
}

throw new Error(
  `The local object-store bucket could not be prepared at ${new URL(endpoint).origin} within 30 seconds (${lastFailure}). Start the core development containers first.`,
);

function required(name: string, legacyName: string): string {
  const value = process.env[name] ?? process.env[legacyName];
  if (value === undefined || value === '') throw new Error(`${name} is required.`);
  return value;
}
