/**
 * Asking for an exported file.
 *
 * Exports live outside Core because they need the document bodies, and Core never touches document
 * content - the block set has one definition, in `@nix/editor-schema`, and a second one in C# to
 * render exports is the drift that package exists to prevent.
 *
 * **Two services answer here, and the format decides which.** `.nix` comes from the collaboration
 * service, which holds the document log; PDF and Word come from the media service, which converts.
 * The shape of the request and of the refusal is identical either way, so this is one function with
 * a base URL looked up per format rather than two clients to keep in step.
 */

import { formatFor, type ExportFormat } from './export-formats';

export type ArchiveScope = 'item' | 'subtree';

export interface ArchiveResult {
  readonly fileName: string;
  readonly blob: Blob;

  /** How many items the archive holds. */
  readonly itemCount: number;

  /**
   * How many were left out - unreadable, deleted, or past the export ceiling.
   *
   * Read from a response header rather than from the archive, so the interface can say what is
   * missing without unpacking a zip it is about to hand to the downloader. The archive's own
   * manifest carries the detail.
   */
  readonly omittedCount: number;
}

export type ArchiveOutcome =
  | { readonly ok: true; readonly value: ArchiveResult }
  | { readonly ok: false; readonly error: string };

export interface ArchiveRequest {
  readonly itemId: string;
  readonly scope: ArchiveScope;

  /** Defaults to the lossless archive, which is what the first version of this only produced. */
  readonly format?: ExportFormat;

  readonly getAccessToken: () => Promise<string | null>;
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export async function requestArchive(request: ArchiveRequest): Promise<ArchiveOutcome> {
  const {
    itemId,
    scope,
    format = 'nix',
    getAccessToken,
    signal,
    fetchImpl = globalThis.fetch,
  } = request;

  const descriptor = formatFor(format);
  const baseUrl = request.baseUrl ?? descriptor.baseUrl;

  const token = await getAccessToken();
  if (token === null) {
    return { ok: false, error: 'Your session has expired. Sign in again to export.' };
  }

  let response: Response;

  try {
    response = await fetchImpl(
      `${baseUrl}/documents/${itemId}/export?scope=${scope}&format=${format}`,
      signal === undefined
        ? { headers: { authorization: `Bearer ${token}` } }
        : { headers: { authorization: `Bearer ${token}` }, signal },
    );
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return { ok: false, error: 'The export was cancelled.' };
    }

    return { ok: false, error: 'The export could not be reached. Check your connection.' };
  }

  if (!response.ok) {
    return { ok: false, error: await refusal(response) };
  }

  // Buffered, deliberately: a download needs the whole file before the browser can name it, and the
  // service caps an export at a size this can hold. When a workspace-sized export arrives it will
  // arrive as a job with a link, not as a bigger buffer here.
  const blob = await response.blob();

  return {
    ok: true,
    value: {
      fileName: fileNameFrom(response.headers.get('content-disposition'), descriptor.extension),
      blob,
      itemCount: count(response.headers.get('x-nix-export-items')),
      omittedCount: count(response.headers.get('x-nix-export-omitted')),
    },
  };
}

/**
 * The service's own words where it gave them, and a plain sentence where it did not.
 *
 * Refusals arrive as RFC 9457 problem details with a stable `code`; a body that is not one is a
 * proxy or a gateway answering instead, and inventing a specific reason for it would be a guess
 * presented as a fact.
 */
async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.length > 0) {
      return body.detail;
    }
  } catch {
    // Falls through to the generic sentence below.
  }

  return response.status === 404
    ? 'That item is no longer available to you.'
    : `The export was refused (${String(response.status)}).`;
}

function count(header: string | null): number {
  if (header === null) {
    return 0;
  }

  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The file name the service chose.
 *
 * Taken from the response rather than built from the item's title here, so the name in the download
 * folder is the one the archive was written under. The fallback exists because a proxy may strip
 * the header, and a download with no name is worse than a generic one.
 */
export function fileNameFrom(header: string | null, extension = 'nix'): string {
  const match = header === null ? null : /filename="([^"]+)"/.exec(header);
  const name = match?.[1];

  return name === undefined || name.length === 0 ? `export.${extension}` : name;
}

/**
 * Hands the archive to the browser's downloader.
 *
 * The object URL is revoked on the next frame rather than immediately: revoking it in the same task
 * as the click races the download in Safari, which has not yet read the blob when the handler
 * returns.
 */
export function saveArchive(result: ArchiveResult, target: Document = document): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = target.createElement('a');

  anchor.href = url;
  anchor.download = result.fileName;
  target.body.append(anchor);
  anchor.click();
  anchor.remove();

  requestAnimationFrame(() => {
    URL.revokeObjectURL(url);
  });
}
