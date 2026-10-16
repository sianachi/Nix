import { open } from 'node:fs/promises';
import { items } from '@nix/api-client';

import { printResult, type OutputOptions } from '../output.ts';
import { readStdin, requireAccessToken, resolveSession, type SessionDeps } from './shared.ts';

const MAX_CANVAS_BYTES = 8 * 1024 * 1024;

async function readCanvasFile(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size > MAX_CANVAS_BYTES) throw new RangeError('The canvas scene file exceeds 8 MiB.');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await file.close();
  }
}

async function canvasSession(profileName: string | undefined, itemId: string, deps: SessionDeps) {
  const session = await resolveSession(profileName, deps);
  const item = await session.client.query(items.itemById(itemId));
  if (item.type !== 'canvas') throw new Error(`Item ${itemId} is a ${item.type}, not a canvas.`);
  return {
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token: await requireAccessToken(session),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
}

export async function readCanvas(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const { readCanvasBody } = await import('../canvas-body.ts');
  printResult(await readCanvasBody(await canvasSession(profileName, itemId, deps)), output);
}

export async function writeCanvas(
  profileName: string | undefined,
  itemId: string,
  options: { readonly file?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps & { readonly readStdin?: () => Promise<string> } = {},
): Promise<void> {
  const source =
    options.file === undefined
      ? await (deps.readStdin ?? (() => readStdin(MAX_CANVAS_BYTES)))()
      : await readCanvasFile(options.file);
  if (Buffer.byteLength(source) > MAX_CANVAS_BYTES)
    throw new Error('The canvas scene file exceeds 8 MiB.');
  const { parseCanvasElements, writeCanvasBody } = await import('../canvas-body.ts');
  const result = await writeCanvasBody({
    ...(await canvasSession(profileName, itemId, deps)),
    elements: parseCanvasElements(JSON.parse(source) as unknown),
  });
  printResult({ id: itemId, written: result.changed > 0, ...result }, output);
}
