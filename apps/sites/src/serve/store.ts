import { signRequest } from '../shared/sigv4.ts';
import type { ServeConfig } from './config.ts';

/** One object read from the bucket, or why there is none. */
export interface StoredObject {
  readonly length: number | null;
  /** Absent for a HEAD. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/** The only thing the serving process needs from storage: read an object by key. */
export interface ObjectReader {
  /** The object, or null when it does not exist. Throws when storage itself is failing. */
  open(key: string, method: 'GET' | 'HEAD'): Promise<StoredObject | null>;
}

/** A path-style S3 reader that signs each GET and HEAD with the process's read credential. */
export function createS3Reader(
  config: ServeConfig['s3'],
  fetchImpl: typeof fetch = fetch,
): ObjectReader {
  return {
    async open(key, method) {
      const url = new URL(
        `${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`,
      );
      const headers = signRequest({
        method,
        url,
        region: config.region,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        now: new Date(),
      });
      // The deadline covers storage answering, not the body: a visitor on a slow link may take
      // longer than 10 s to read a large download, and the stream must not be cut under them.
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        deadline.abort(new Error('Object storage did not answer in time.'));
      }, 10_000);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          redirect: 'manual',
          signal: deadline.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Object storage answered ${String(response.status)}.`);
      }
      const length = Number(response.headers.get('content-length') ?? Number.NaN);
      return {
        length: Number.isFinite(length) ? length : null,
        body: method === 'HEAD' ? null : response.body,
      };
    },
  };
}
