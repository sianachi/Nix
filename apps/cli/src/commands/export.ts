/**
 * `nixctl export`: ask Core for a durable export, wait for its worker, then stream the result.
 *
 * Core is the only product service this command knows. It advertises the formats whose workers are
 * currently alive, owns the durable job and authorizes the final private-object capability. The
 * capability carries bytes only; it receives no bearer token and cannot redirect the CLI to a
 * different origin.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  httpStatusCode,
  isNixApiError,
  NixApiError,
  NixErrorKind,
  type TokenProvider,
} from '@nix/api-client';
import { z } from 'zod';

import { printResult, type OutputOptions } from '../output.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

export type ExportScope = 'item' | 'subtree';

const SCOPES = new Set<ExportScope>(['item', 'subtree']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const POLL_INITIAL_DELAY_MS = 250;
const POLL_MAX_DELAY_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;
const CORE_REQUEST_TIMEOUT_MS = 15_000;
const CANCELLATION_TIMEOUT_MS = 5_000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

const exportFormatSchema = z.object({
  format: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(100),
  extension: z.string().regex(/^[a-z0-9]{1,16}$/),
  mediaType: z.string().min(3).max(128),
  lossless: z.boolean(),
  declaredLoss: z.array(z.string().min(1).max(500)).max(32),
});

const exportFormatCatalogSchema = z.object({
  formats: z.array(exportFormatSchema).max(64),
  observedAt: z.string().min(1),
});

const exportStatusSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  workspaceId: z.uuid(),
  format: z.string().min(1).max(32),
  scope: z.enum(['item', 'subtree']),
  fileName: z.string().min(1).max(256),
  mediaType: z.string().min(3).max(128),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  itemCount: z.number().int().nonnegative().nullable(),
  omittedCount: z.number().int().nonnegative().nullable(),
  byteLength: z.number().int().positive().max(MAX_EXPORT_BYTES).nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullable(),
  loss: z.array(z.string().min(1).max(500)),
  omissions: z.array(z.string().min(1).max(500)),
  failureCode: z.string().nullable(),
  failureDetail: z.string().nullable(),
  cancellationRequested: z.boolean(),
  downloadReady: z.boolean(),
  createdAt: z.string().min(1),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

const exportDownloadCapabilitySchema = z.object({
  url: z.url(),
  expiresAt: z.string().min(1),
  fileName: z.string().min(1).max(256),
  mediaType: z.string().min(3).max(128),
  byteLength: z.number().int().positive().max(MAX_EXPORT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
});

type ExportFormat = z.infer<typeof exportFormatSchema>;
type ExportFormatCatalog = z.infer<typeof exportFormatCatalogSchema>;
type ExportStatus = z.infer<typeof exportStatusSchema>;
type ExportDownloadCapability = z.infer<typeof exportDownloadCapabilitySchema>;

export interface ExportOptions {
  readonly format: string;
  readonly scope: string;
  /** Where the bytes go; without it they go to stdout (refused on a terminal — they are binary). */
  readonly out?: string | undefined;
}

interface ExportDeps extends SessionDeps {
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly stdout?: Writable;
}

interface CoreExportClient {
  readonly formats: (signal: AbortSignal) => Promise<ExportFormatCatalog>;
  readonly begin: (
    input: {
      readonly itemId: string;
      readonly format: string;
      readonly scope: ExportScope;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ) => Promise<ExportStatus>;
  readonly get: (exportId: string, signal: AbortSignal) => Promise<ExportStatus>;
  readonly cancel: (exportId: string, signal: AbortSignal) => Promise<void>;
  readonly download: (exportId: string, signal: AbortSignal) => Promise<ExportDownloadCapability>;
}

/** Creates a durable export and either writes it to `--out` or streams its verified bytes to stdout. */
export async function runExport(
  profileName: string | undefined,
  itemId: string,
  options: ExportOptions,
  output: OutputOptions,
  deps: ExportDeps = {},
): Promise<void> {
  const requestedFormat = normaliseFormat(options.format);
  const scope = asScope(options.scope);

  if (options.out === undefined && output.isTty) {
    throw new Error(
      'An export is binary. Give -o <file> to write it, or pipe stdout (for example, `> out.' +
        requestedFormat +
        '`).',
    );
  }

  const commandAbort = createCommandAbort(deps.signal);
  const signal = commandAbort.signal;
  const makeId = deps.randomUUID ?? randomUUID;
  let latest: ExportStatus | null = null;
  let core: CoreExportClient | null = null;

  try {
    const session = await resolveSession(profileName, deps);
    core = createCoreExportClient(
      session.endpoints.apiUrl,
      session.tokens,
      deps.fetchImpl ?? globalThis.fetch,
    );
    const catalog = await core.formats(signal);
    const advertised = chooseFormat(catalog.formats, requestedFormat);

    latest = await core.begin(
      {
        itemId,
        format: advertised.format,
        scope,
        idempotencyKey: `nixctl-export:${itemId}:${advertised.format}:${scope}:${makeId()}`,
      },
      signal,
    );
    assertExportIdentity(latest, itemId, advertised.format, scope);

    latest = await waitForExport(core, latest, signal, {
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? delay,
      onState: (state) => {
        latest = state;
      },
    });

    const capability = await core.download(latest.id, signal);
    assertCapabilityMatches(latest, capability);

    const downloaded = await streamDownload(
      capability,
      options.out,
      deps.fetchImpl ?? globalThis.fetch,
      signal,
      deps.stdout ?? process.stdout,
      makeId,
    );

    if (options.out === undefined) {
      return;
    }

    printResult(
      {
        id: itemId,
        exportId: latest.id,
        itemId,
        workspaceId: latest.workspaceId,
        status: latest.status,
        format: requestedFormat,
        canonicalFormat: latest.format,
        scope: latest.scope,
        file: options.out,
        fileName: capability.fileName,
        mediaType: capability.mediaType,
        bytes: downloaded.byteLength,
        sha256: downloaded.sha256,
        items: latest.itemCount,
        omitted: latest.omittedCount,
        loss: latest.loss,
        omissions: latest.omissions,
        completedAt: latest.completedAt,
        expiresAt: latest.expiresAt,
      },
      output,
    );
  } catch (error) {
    if (core !== null && latest !== null && ACTIVE_STATUSES.has(latest.status)) {
      await cancelBestEffort(core, latest.id);
    }
    if (signal.aborted) {
      throw abortReason(signal);
    }
    throw error;
  } finally {
    commandAbort.dispose();
  }
}

function createCoreExportClient(
  apiUrl: string,
  tokens: TokenProvider,
  fetchImpl: NonNullable<SessionDeps['fetchImpl']>,
): CoreExportClient {
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> => {
    let token = await tokens.getAccessToken();
    if (token === null) {
      throw new Error('Could not obtain a session for this profile.');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(CORE_REQUEST_TIMEOUT_MS);
      const requestSignal = AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
          method,
          headers: {
            accept: 'application/json, application/problem+json',
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          credentials: 'omit',
          signal: requestSignal,
        });
      } catch (cause) {
        if (signal.aborted) {
          throw abortReason(signal);
        }
        if (timeout.aborted) {
          throw NixApiError.timeout(CORE_REQUEST_TIMEOUT_MS, cause);
        }
        throw NixApiError.network(cause);
      }

      if (response.status === 401 && attempt === 0) {
        token = await tokens.refreshAccessToken();
        if (token === null) {
          throw new Error('Could not refresh the session for this profile.');
        }
        continue;
      }
      if (!response.ok) {
        throw await coreRefusal(response);
      }
      if (response.status === 204) {
        return undefined;
      }
      try {
        return await response.json();
      } catch (cause) {
        throw new Error('Core returned a malformed export response.', { cause });
      }
    }
    throw new Error('Could not refresh the session for this profile.');
  };

  return {
    formats: async (signal) =>
      exportFormatCatalogSchema.parse(await request('GET', '/api/v1/exports/formats', signal)),
    begin: async (input, signal) =>
      exportStatusSchema.parse(await request('POST', '/api/v1/exports', signal, input)),
    get: async (exportId, signal) =>
      exportStatusSchema.parse(await request('GET', `/api/v1/exports/${exportId}`, signal)),
    cancel: async (exportId, signal) => {
      await request('POST', `/api/v1/exports/${exportId}/cancel`, signal);
    },
    download: async (exportId, signal) =>
      exportDownloadCapabilitySchema.parse(
        await request('GET', `/api/v1/exports/${exportId}/download`, signal),
      ),
  };
}

async function waitForExport(
  core: CoreExportClient,
  initial: ExportStatus,
  signal: AbortSignal,
  options: {
    readonly now: () => number;
    readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly onState: (state: ExportStatus) => void;
  },
): Promise<ExportStatus> {
  const deadline = options.now() + POLL_TIMEOUT_MS;
  let state = initial;
  let delayMs = POLL_INITIAL_DELAY_MS;

  for (;;) {
    signal.throwIfAborted();
    if (state.status === 'completed') {
      if (!state.downloadReady) {
        throw new Error(
          'The export completed, but its downloadable result is no longer available.',
        );
      }
      return state;
    }
    if (state.status === 'failed') {
      throw new Error(state.failureDetail ?? state.failureCode ?? 'The export worker failed.');
    }
    if (state.status === 'cancelled') {
      throw new Error(state.failureDetail ?? 'The export was cancelled.');
    }

    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) {
      throw new Error(`Export ${state.id} did not finish within 10 minutes.`);
    }
    await options.sleep(Math.min(delayMs, remainingMs), signal);
    signal.throwIfAborted();

    try {
      const next = await core.get(state.id, signal);
      assertExportIdentity(next, state.itemId, state.format, state.scope);
      if (next.id !== state.id) {
        throw new Error('Core returned a different durable export while polling.');
      }
      state = next;
      options.onState(state);
    } catch (error) {
      if (!retryablePollFailure(error) || options.now() >= deadline) {
        throw error;
      }
    }

    delayMs = Math.min(delayMs * 2, POLL_MAX_DELAY_MS);
  }
}

function retryablePollFailure(error: unknown): boolean {
  if (!isNixApiError(error)) {
    return false;
  }
  return (
    error.kind === NixErrorKind.Network ||
    error.kind === NixErrorKind.Timeout ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  );
}

async function streamDownload(
  capability: ExportDownloadCapability,
  outputPath: string | undefined,
  fetchImpl: NonNullable<SessionDeps['fetchImpl']>,
  signal: AbortSignal,
  stdout: Writable,
  makeId: () => string,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const url = capabilityUrl(capability.url);
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) {
    throw new Error(`The export download was refused (${String(response.status)}).`);
  }
  if (response.body === null) {
    throw new Error('The object store returned no export body.');
  }

  if (outputPath === undefined) {
    const result = await pipeAndMeasure(
      response.body,
      forwardingSink(stdout),
      capability.byteLength,
      signal,
    );
    verifyDownload(result, capability);
    return result;
  }

  const temporaryPath = `${outputPath}.nixctl-${makeId()}.part`;
  try {
    const result = await pipeAndMeasure(
      response.body,
      createWriteStream(temporaryPath, { flags: 'wx' }),
      capability.byteLength,
      signal,
    );
    verifyDownload(result, capability);
    await rename(temporaryPath, outputPath);
    return result;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function pipeAndMeasure(
  body: ReadableStream<Uint8Array>,
  destination: Writable,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      if (byteLength + chunk.byteLength > maximumBytes) {
        callback(new Error('The downloaded export exceeded its declared byte count.'));
        return;
      }
      byteLength += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body), meter, destination, { signal });
  return { byteLength, sha256: hash.digest('hex') };
}

/** Ends a disposable wrapper after piping without ever ending or destroying the real stdout. */
function forwardingSink(target: Writable): Writable {
  return new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      target.write(chunk, encoding, callback);
    },
  });
}

function verifyDownload(
  actual: { readonly byteLength: number; readonly sha256: string },
  declared: ExportDownloadCapability,
): void {
  if (actual.byteLength !== declared.byteLength) {
    throw new Error(
      `The downloaded export size did not match its capability (expected ${String(declared.byteLength)}, received ${String(actual.byteLength)}).`,
    );
  }
  if (actual.sha256 !== declared.sha256.toLowerCase()) {
    throw new Error('The downloaded export checksum did not match its capability.');
  }
}

function assertCapabilityMatches(state: ExportStatus, capability: ExportDownloadCapability): void {
  if (
    state.byteLength === null ||
    state.sha256 === null ||
    capability.byteLength !== state.byteLength ||
    capability.sha256.toLowerCase() !== state.sha256.toLowerCase() ||
    capability.fileName !== state.fileName ||
    capability.mediaType !== state.mediaType
  ) {
    throw new Error('The export download capability did not match the completed durable export.');
  }
}

function assertExportIdentity(
  state: ExportStatus,
  itemId: string,
  format: string,
  scope: ExportScope,
): void {
  if (state.itemId !== itemId || state.format !== format || state.scope !== scope) {
    throw new Error(
      'Core returned an export that did not match the requested item, format, and scope.',
    );
  }
}

async function cancelBestEffort(core: CoreExportClient, exportId: string): Promise<void> {
  try {
    await core.cancel(exportId, AbortSignal.timeout(CANCELLATION_TIMEOUT_MS));
  } catch {
    // The worker may have reached a terminal state while the caller was stopping; Core's expiry
    // cleanup remains the backstop if this bounded cancellation cannot be delivered.
  }
}

function chooseFormat(formats: readonly ExportFormat[], requested: string): ExportFormat {
  const canonical = requested === 'md' ? 'markdown' : requested;
  const match = formats.find((candidate) => candidate.format === canonical);
  if (match !== undefined) {
    return match;
  }
  const available = formats.map((candidate) =>
    candidate.format === 'markdown' ? 'md' : candidate.format,
  );
  if (available.length === 0) {
    throw new Error(
      'No export formats are currently available. Start an export worker and try again.',
    );
  }
  throw new Error(
    `Format '${requested}' is not currently available. Active formats: ${available.sort().join(', ')}.`,
  );
}

function normaliseFormat(value: string): string {
  const normalised = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(normalised)) {
    throw new Error(`Invalid export format '${value}'. Use a format advertised by Core.`);
  }
  return normalised;
}

function asScope(value: string): ExportScope {
  const normalised = value.trim().toLowerCase();
  if (!SCOPES.has(normalised as ExportScope)) {
    throw new Error(`Unknown scope '${value}'. Use 'item' or 'subtree'.`);
  }
  return normalised as ExportScope;
}

function capabilityUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Export download capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Export download capabilities cannot contain URL credentials.');
  }
  return url;
}

async function coreRefusal(response: Response): Promise<NixApiError> {
  const body = (await response.json().catch(() => null)) as {
    readonly code?: unknown;
    readonly title?: unknown;
    readonly detail?: unknown;
  } | null;
  const code = typeof body?.code === 'string' && body.code.length > 0 ? body.code : null;
  const title = typeof body?.title === 'string' && body.title.length > 0 ? body.title : undefined;
  const detail =
    typeof body?.detail === 'string' && body.detail.length > 0 ? body.detail : undefined;
  const message =
    detail ??
    title ??
    (response.status === 404
      ? 'That export is no longer available to you.'
      : `The export request was refused (${String(response.status)}).`);
  return new NixApiError({
    kind: code === null ? NixErrorKind.Http : NixErrorKind.Problem,
    code: code ?? httpStatusCode(response.status),
    message,
    status: response.status,
    title,
    detail: message,
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });

    function finish(): void {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      globalThis.clearTimeout(timer);
      reject(abortReason(signal));
    }
  });
}

function createCommandAbort(external: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const relayExternal = (): void => {
    controller.abort(external === undefined ? undefined : abortReason(external));
  };
  const interrupt = (): void => {
    controller.abort(new Error('The export was interrupted.'));
  };

  if (external?.aborted === true) {
    relayExternal();
  } else {
    external?.addEventListener('abort', relayExternal, { once: true });
  }
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  return {
    signal: controller.signal,
    dispose: () => {
      external?.removeEventListener('abort', relayExternal);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The export was cancelled.');
}
