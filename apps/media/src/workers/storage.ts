import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { BundleStream } from '../collab/bundles.ts';

export interface StagedExport {
  readonly workspaceId: string;
  readonly sourceUrl: string;
  readonly destinationUrl: string;
  readonly sourceKey: string;
  readonly destinationKey: string;
}

export interface StagedImport {
  readonly sourceUrl: string;
  readonly sourceKey: string;
}

export interface WorkerStorage {
  stageExport(stream: BundleStream, format: string, signal: AbortSignal): Promise<StagedExport>;
  stageImport(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<StagedImport>;
  result(key: string, signal: AbortSignal): Promise<Readable>;
  remove(staged: StagedExport): Promise<void>;
  removeImport(staged: StagedImport): Promise<void>;
}

interface ObjectStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export class WorkerObjectStore implements WorkerStorage {
  readonly #options: ObjectStoreOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ObjectStoreOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async stageExport(
    stream: BundleStream,
    format: string,
    signal: AbortSignal,
  ): Promise<StagedExport> {
    const prefix = `worker-jobs/${randomUUID()}`;
    const sourceKey = `${prefix}/source.ndjson`;
    const destinationKey = `${prefix}/result.${extension(format)}`;
    let workspaceId = '';
    const body = Readable.from(
      encode(stream, (value) => {
        workspaceId ||= value;
      }),
    );
    await this.#put(sourceKey, body, 'application/x-ndjson', signal);
    if (workspaceId === '') {
      await this.#delete(sourceKey).catch(() => undefined);
      throw new Error('The authorized export stream contained no root bundle.');
    }
    return {
      workspaceId,
      sourceUrl: this.#url('GET', sourceKey),
      destinationUrl: this.#url('PUT', destinationKey),
      sourceKey,
      destinationKey,
    };
  }

  async stageImport(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<StagedImport> {
    const sourceKey = `worker-jobs/${randomUUID()}/source.nix`;
    await this.#put(sourceKey, Readable.from(source), 'application/zip', signal);
    return { sourceUrl: this.#url('GET', sourceKey), sourceKey };
  }

  async result(key: string, signal: AbortSignal): Promise<Readable> {
    const response = await this.#fetch(this.#url('GET', key), { signal });
    if (!response.ok || response.body === null) {
      throw new Error(`The worker output object could not be read (${String(response.status)}).`);
    }
    return Readable.fromWeb(response.body);
  }

  async remove(staged: StagedExport): Promise<void> {
    await Promise.all([this.#delete(staged.sourceKey), this.#delete(staged.destinationKey)]);
  }

  async removeImport(staged: StagedImport): Promise<void> {
    await this.#delete(staged.sourceKey);
  }

  async #put(key: string, body: Readable, contentType: string, signal: AbortSignal): Promise<void> {
    const response = await this.#fetch(this.#url('PUT', key), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: Readable.toWeb(body),
      signal,
      // Node's fetch requires this for a streamed request body. Browsers do not expose this option.
      duplex: 'half',
    });
    if (!response.ok) {
      throw new Error(`The worker source object could not be staged (${String(response.status)}).`);
    }
  }

  async #delete(key: string): Promise<void> {
    const response = await this.#fetch(this.#url('DELETE', key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `The transient worker object could not be removed (${String(response.status)}).`,
      );
    }
  }

  #url(method: 'GET' | 'PUT' | 'DELETE', key: string): string {
    return presignS3({ ...this.#options, method, key, expiresSeconds: 900 });
  }
}

export function presignS3(
  options: ObjectStoreOptions & {
    readonly method: 'GET' | 'PUT' | 'DELETE';
    readonly key: string;
    readonly expiresSeconds: number;
  },
): string {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== 'https:' &&
    endpoint.hostname !== 'localhost' &&
    endpoint.hostname !== '127.0.0.1'
  ) {
    throw new Error('The worker object-store endpoint must use HTTPS outside local development.');
  }
  const now = options.now?.() ?? new Date();
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${options.region}/s3/aws4_request`;
  const path = [
    endpoint.pathname.replace(/^\/+|\/+$/g, ''),
    options.bucket,
    ...options.key.split('/'),
  ]
    .filter((part) => part !== '')
    .map(uriEncode)
    .join('/');
  endpoint.pathname = `/${path}`;
  const parameters: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${options.accessKey}/${scope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(options.expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalRequest = [
    options.method,
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
  const dateKey = createHmac('sha256', `AWS4${options.secretKey}`).update(day).digest();
  const regionKey = createHmac('sha256', dateKey).update(options.region).digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  parameters['X-Amz-Signature'] = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  endpoint.search = canonicalQuery(parameters);
  return endpoint.toString();
}

async function* encode(
  stream: BundleStream,
  workspace: (value: string) => void,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  yield encoder.encode(`${JSON.stringify(stream.manifest)}\n`);
  let items = 0;
  for await (const bundle of stream.bundles) {
    workspace(bundle.workspaceId);
    items += 1;
    yield encoder.encode(`${JSON.stringify(bundle)}\n`);
  }
  yield encoder.encode(`${JSON.stringify({ end: true, items })}\n`);
}

function canonicalQuery(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function extension(format: string): string {
  return format === 'markdown' ? 'md' : format;
}
