import type { ArchiveManifest, ItemBundle } from '@nix/export';

/**
 * Reading item bundles from the collaboration service.
 *
 * **This service holds no database credentials, so this is the only way it sees a document.** The
 * collaboration service owns the content log; it authorizes the caller through Core and streams the
 * result as newline-delimited JSON. Two facts go out with the request: the internal secret, saying
 * which service is asking, and the caller's own bearer token, saying on whose behalf. This process
 * holds no authority of its own and never decides a permission.
 *
 * **A stream that ends without its sentinel is refused.** Truncated NDJSON is still a run of valid
 * JSON lines, so accepting one would mean converting a short document into a plausible, complete-
 * looking PDF - the worst available outcome, because nothing downstream could tell. The count in the
 * sentinel is checked too, so a stream that ends tidily but short is caught as well.
 */

export interface BundleStream {
  readonly manifest: ArchiveManifest;

  /** The bundles, in the manifest's order. Refuses mid-iteration if the stream is not intact. */
  readonly bundles: AsyncGenerator<ItemBundle>;
}

/**
 * Why a bundle read did not produce a stream. Mapped to a status by the caller, never here.
 *
 * The fields are assigned in the body rather than declared as constructor parameter properties.
 * That is not style: this service runs from source under Node's type-stripping loader, which
 * removes types without rewriting anything, and a parameter property *is* a rewrite - it refuses
 * the file outright with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Vitest compiles through esbuild and
 * accepts it happily, so the suite stays green while the service cannot boot.
 */
export class BundleRefusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'BundleRefusal';
    this.status = status;
    this.code = code;
  }
}

export interface BundleReaderOptions {
  readonly collabBaseUrl: string;
  readonly internalSecret: string;
  readonly maxBytes: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BundleReader {
  read(input: {
    readonly token: string;
    readonly itemId: string;
    readonly scope: 'item' | 'subtree';
    readonly signal: AbortSignal;
  }): Promise<BundleStream>;
}

export function createBundleReader(options: BundleReaderOptions): BundleReader {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async read({ token, itemId, scope, signal }): Promise<BundleStream> {
      const url = `${options.collabBaseUrl}/documents/${itemId}/bundles?scope=${scope}`;

      let response: Response;

      try {
        response = await doFetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            'x-nix-internal-secret': options.internalSecret,
            accept: 'application/x-ndjson',
          },
          signal,
        });
      } catch {
        // A collaboration service that cannot be reached is this service's problem to report, not
        // something to blame the caller for.
        throw new BundleRefusal(
          502,
          'documents_unavailable',
          'The document could not be read. Try again in a moment.',
        );
      }

      if (!response.ok) {
        // **Forwarded, not translated.** A 401 stays a 401 and a 404 stays a 404, carrying the
        // other service's own sentence: it made the authorization decision, so it owns the wording,
        // and the web client already knows how to read an RFC 9457 body from either service.
        throw await refusalOf(response);
      }

      if (response.body === null) {
        throw new BundleRefusal(502, 'documents_unavailable', 'The document stream was empty.');
      }

      const lines = readLines(response.body, options.maxBytes);
      const first = await lines.next();

      if (first.done === true) {
        throw new BundleRefusal(502, 'documents_unavailable', 'The document stream was empty.');
      }

      const manifest = parse(first.value);

      if (!isManifest(manifest)) {
        throw new BundleRefusal(
          502,
          'documents_unavailable',
          'The document stream did not begin with a manifest.',
        );
      }

      return { manifest, bundles: readBundles(lines) };
    },
  };
}

/**
 * The bundles, checked as they go.
 *
 * The sentinel is verified when the stream ends, which is the only moment it can be: a generator
 * cannot know it was truncated until it stops. A caller that abandons the iteration early gets no
 * verification and needs none - it is not going to produce a file.
 */
async function* readBundles(lines: AsyncGenerator<string>): AsyncGenerator<ItemBundle> {
  let count = 0;

  for (;;) {
    const next = await lines.next();

    if (next.done === true) {
      throw new BundleRefusal(
        502,
        'documents_incomplete',
        'The document stream ended early. Nothing was written, rather than writing part of a file.',
      );
    }

    const value = parse(next.value);

    if (isEnd(value)) {
      if (value.items !== count) {
        throw new BundleRefusal(
          502,
          'documents_incomplete',
          `The document stream said it held ${String(value.items)} items and carried ${String(count)}.`,
        );
      }

      return;
    }

    if (!isBundle(value)) {
      throw new BundleRefusal(
        502,
        'documents_incomplete',
        'The document stream held a line that was not an item.',
      );
    }

    count += 1;
    yield value;
  }
}

/**
 * The stream, split on newlines, bounded in total.
 *
 * The ceiling is on bytes rather than on lines because a single hostile line is the shape that
 * matters: a line-counting limit would let one unbounded line fill memory before it was ever
 * counted.
 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let seen = 0;

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    seen += chunk.byteLength;

    if (seen > maxBytes) {
      throw new BundleRefusal(
        413,
        'export_too_large',
        'This export is larger than one request carries. Export a smaller part of the tree.',
      );
    }

    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }

  // A trailing fragment with no newline is a truncated line. Yielding it would hand a half-written
  // bundle to JSON.parse and turn a truncation into a parse error that blames the wrong thing.
  if (buffer.trim().length > 0) {
    throw new BundleRefusal(502, 'documents_incomplete', 'The document stream ended mid-line.');
  }
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new BundleRefusal(
      502,
      'documents_incomplete',
      'The document stream held a line that was not readable.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManifest(value: unknown): value is ArchiveManifest {
  return isRecord(value) && typeof value.format === 'string' && Array.isArray(value.items);
}

function isEnd(value: unknown): value is { end: true; items: number } {
  return isRecord(value) && value.end === true && typeof value.items === 'number';
}

function isBundle(value: unknown): value is ItemBundle {
  return isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string';
}

/**
 * The other service's refusal, in its own words where it gave them.
 *
 * The body is read exactly once - a `Response` can only be consumed once, and reading it twice for
 * the code and the detail separately would leave the second read empty and the detail generic.
 */
async function refusalOf(response: Response): Promise<BundleRefusal> {
  const body: unknown = await response.json().catch(() => null);

  const code =
    isRecord(body) && typeof body.code === 'string' ? body.code : 'documents_unavailable';

  const detail =
    isRecord(body) && typeof body.detail === 'string' && body.detail.length > 0
      ? body.detail
      : 'The document could not be read.';

  return new BundleRefusal(response.status, code, detail);
}
