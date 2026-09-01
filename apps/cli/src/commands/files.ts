import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { files as fileResources } from '@nix/api-client';

import { printResult, type OutputOptions } from '../output.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

export interface UploadFileInput {
  readonly workspaceId: string;
  readonly path: string;
  readonly parentId?: string;
  readonly targetItemId?: string;
}

export async function uploadFileValue(
  profileName: string | undefined,
  input: UploadFileInput,
  deps: SessionDeps = {},
): Promise<unknown> {
  const session = await resolveSession(profileName, deps);
  const metadata = await stat(input.path);
  if (!metadata.isFile()) throw new Error(`${input.path} is not a file.`);
  if (metadata.size > 100 * 1024 * 1024)
    throw new Error('The file exceeds the 100 MiB upload limit.');
  const upload = await session.client.execute(
    fileResources.beginUpload({
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      targetItemId: input.targetItemId ?? null,
      fileName: basename(input.path),
      mediaType: 'application/octet-stream',
      byteLength: metadata.size,
      idempotencyKey: `cli-file:${crypto.randomUUID()}`,
    }),
  );
  if (upload.uploadUrl === null) {
    throw new Error('The upload capability is no longer available.');
  }
  try {
    const uploadUrl = capabilityUrl(upload.uploadUrl);
    const uploaded = await (deps.fetchImpl ?? globalThis.fetch)(uploadUrl.toString(), {
      method: 'PUT',
      body: createReadStream(input.path),
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(metadata.size),
      },
      duplex: 'half',
      redirect: 'error',
      credentials: 'omit',
    });
    if (!uploaded.ok) {
      throw new Error(`The object upload was refused (${String(uploaded.status)}).`);
    }
    return await fileResources.completeUploadAndWait(session.client, upload);
  } catch (error) {
    try {
      await session.client.execute(fileResources.cancelUpload(upload.id));
    } catch {
      // The worker or expiry reaper may already own cleanup.
    }
    throw error;
  }
}

export async function uploadFile(
  profileName: string | undefined,
  input: UploadFileInput,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  printResult(await uploadFileValue(profileName, input, deps), output);
}

export async function listFileVersions(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(fileResources.fileByItem(itemId)), output);
}

export async function downloadFile(
  profileName: string | undefined,
  itemId: string,
  out: string,
  versionId: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  printResult(await downloadFileValue(profileName, itemId, out, versionId, deps), output);
}

export async function downloadFileValue(
  profileName: string | undefined,
  itemId: string,
  out: string,
  versionId: string | undefined,
  deps: SessionDeps = {},
): Promise<unknown> {
  const session = await resolveSession(profileName, deps);
  const capability = await session.client.query(fileResources.downloadFile(itemId, versionId), {
    forceRefresh: true,
  });
  const url = capabilityUrl(capability.url);
  const response = await (deps.fetchImpl ?? globalThis.fetch)(url.toString(), {
    redirect: 'error',
    credentials: 'omit',
  });
  if (!response.ok) throw await refusal(response);
  if (response.body === null) throw new Error('The object store returned no file body.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(out, { flags: 'wx' }));
  const written = await stat(out);
  if (written.size !== capability.byteLength) {
    throw new Error('The downloaded file size did not match its capability.');
  }
  return { itemId, versionId: versionId ?? null, file: out, bytes: written.size };
}

function capabilityUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Object capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Object capabilities cannot contain URL credentials.');
  }
  return url;
}

async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return new Error(
    typeof body?.detail === 'string'
      ? body.detail
      : `The file operation was refused (${String(response.status)}).`,
  );
}
