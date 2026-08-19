/**
 * `nixctl export`: download an exported file, in any format the product offers.
 *
 * Two services answer and the format decides which: `.nix` (lossless, every body kind) comes from
 * the collaboration service, and `md`/`pdf`/`docx` from the media service — the same split the web
 * dialog makes, and the reason the base URL is chosen per format rather than fixed. The request and
 * the refusal are identical either way, so this is one fetch with the base URL looked up per format.
 *
 * `--format nix` is the universal escape hatch for a body Markdown cannot carry (a canvas, a
 * spreadsheet), which is what `note read` points a caller at. The produced file states its own
 * losses; this command only carries the bytes and the counts the service reports.
 */

import { writeFile } from 'node:fs/promises';
import { NixApiError, NixErrorKind, httpStatusCode } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

export type ExportFormat = 'nix' | 'md' | 'pdf' | 'docx';
export type ExportScope = 'item' | 'subtree';

const FORMATS = new Set<ExportFormat>(['nix', 'md', 'pdf', 'docx']);
const SCOPES = new Set<ExportScope>(['item', 'subtree']);

export interface ExportOptions {
  readonly format: string;
  readonly scope: string;
  /** Where the bytes go; without it they go to stdout (refused on a terminal — they are binary). */
  readonly out?: string | undefined;
}

/** Downloads an export and either writes it to `--out` (printing a summary) or streams it to stdout. */
export async function runExport(
  profileName: string | undefined,
  itemId: string,
  options: ExportOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const format = asFormat(options.format);
  const scope = asScope(options.scope);

  if (options.out === undefined && output.isTty) {
    throw new Error(
      'An export is binary. Give -o <file> to write it, or pipe stdout (e.g. `> out.' + format + '`).',
    );
  }

  const session = await resolveSession(profileName, deps);
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error('Could not obtain a session for this profile.');
  }

  // `.nix` is the collaboration service's promise you can leave with everything; the converted
  // formats come from media. This is the one routing fact the CLI keeps, matching the web dialog.
  const baseUrl = format === 'nix' ? session.endpoints.collabUrl : session.endpoints.mediaUrl;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const response = await fetchImpl(
    `${baseUrl}/documents/${itemId}/export?scope=${scope}&format=${format}`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    throw await refusal(response);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const items = count(response.headers.get('x-nix-export-items'));
  const omitted = count(response.headers.get('x-nix-export-omitted'));

  if (options.out === undefined) {
    process.stdout.write(bytes);
    return;
  }

  await writeFile(options.out, bytes);
  printResult({ id: itemId, format, scope, file: options.out, bytes: bytes.byteLength, items, omitted }, output);
}

function asFormat(value: string): ExportFormat {
  if (!FORMATS.has(value as ExportFormat)) {
    throw new Error(`Unknown format '${value}'. Use one of: nix, md, pdf, docx.`);
  }
  return value as ExportFormat;
}

function asScope(value: string): ExportScope {
  if (!SCOPES.has(value as ExportScope)) {
    throw new Error(`Unknown scope '${value}'. Use 'item' or 'subtree'.`);
  }
  return value as ExportScope;
}

/**
 * Turns a failed export response into a `NixApiError`, so the CLI's own exit-code mapping applies:
 * 404 leaves 4, 403 leaves 3. The service's own `detail` is passed through verbatim where it gave
 * one, and a plain sentence stands in where a proxy answered instead.
 */
async function refusal(response: Response): Promise<NixApiError> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.length > 0) {
      detail = body.detail;
    }
  } catch {
    // A non-JSON body is a gateway or proxy; the generic sentence below stands in.
  }

  const message =
    detail ??
    (response.status === 404
      ? 'That item is no longer available to you.'
      : `The export was refused (${String(response.status)}).`);

  return new NixApiError({
    kind: NixErrorKind.Http,
    code: httpStatusCode(response.status),
    message,
    status: response.status,
    detail: message,
  });
}

function count(header: string | null): number {
  if (header === null) {
    return 0;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
