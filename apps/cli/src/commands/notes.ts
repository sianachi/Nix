/**
 * `nixctl note read` / `nixctl note write`: a note's body, as Markdown.
 *
 * The body is the one thing not in Core's REST API - it lives in the collaboration service - so
 * these two commands are the CLI's reason for speaking that protocol. Reading prints the Markdown
 * (and, on stdout-as-a-terminal, just the text; piped, a JSON envelope carrying the losses so a
 * script can see what Markdown could not hold). Writing takes Markdown on stdin or from a file and
 * replaces the body with it, as a minimal change Yjs merges rather than a clobber.
 *
 * The body service and the CRDT runtime it pulls in are dynamic-imported, so a session that never
 * touches a body never loads them.
 */

import { readFile } from 'node:fs/promises';
import { items } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/**
 * Body kinds Markdown cannot carry. An item's `type` is an open string, so this refuses only the
 * kinds known not to be prose and lets a note - or a body kind this build has not heard of - through
 * to the reader, which is the safe direction: a new prose kind reads best-effort rather than being
 * blocked, and a drawing or a grid is turned away with a pointer rather than read as an empty note.
 */
const NON_PROSE_BODY_KINDS = new Set(['canvas', 'spreadsheet']);

export interface ReadOptions {
  /** Print only the Markdown text, even when piped, rather than the JSON envelope. */
  readonly raw: boolean;
}

/** Reads a note body and prints it as Markdown. */
export async function readNote(
  profileName: string | undefined,
  itemId: string,
  options: ReadOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error('Could not obtain a session for this profile.');
  }

  // Read the item's kind before its body, so a canvas or a spreadsheet is refused with a pointer
  // rather than read through the prose fragment - which is empty for those - and reported as an
  // empty note. This is what a stress run walking a mixed workspace needs so it never records a
  // drawing as "no content".
  const item = await session.client.query(items.itemById(itemId));
  if (NON_PROSE_BODY_KINDS.has(item.type)) {
    throw new Error(
      `Item ${itemId} is a ${item.type}, which Markdown cannot carry. ` +
        'Use `nixctl export ' +
        itemId +
        ' --format nix` for its full content.',
    );
  }

  const { readBodyMarkdown } = await import('../body.ts');
  const body = await readBodyMarkdown({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // Raw, or reading into a terminal, prints just the text - what a person or a `> note.md` wants.
  // Piped without --raw, a JSON envelope carries the losses so nothing is dropped silently.
  if (options.raw || (output.isTty && !output.json)) {
    process.stdout.write(body.markdown.endsWith('\n') ? body.markdown : `${body.markdown}\n`);
    return;
  }

  printResult(
    { markdown: body.markdown, schemaVersion: body.schemaVersion, empty: body.empty, losses: body.losses },
    output,
  );
}

export interface WriteOptions {
  /** Read the Markdown from this file instead of stdin. */
  readonly file?: string | undefined;
}

/** Replaces a note body with Markdown from a file or stdin. */
export async function writeNote(
  profileName: string | undefined,
  itemId: string,
  options: WriteOptions,
  output: OutputOptions,
  deps: SessionDeps & { readonly readStdin?: () => Promise<string> } = {},
): Promise<void> {
  const markdown = options.file !== undefined ? await readFile(options.file, 'utf8') : await (deps.readStdin ?? readStdin)();

  const session = await resolveSession(profileName, deps);
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error('Could not obtain a session for this profile.');
  }

  const { writeBodyMarkdown } = await import('../body.ts');
  const result = await writeBodyMarkdown({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    markdown,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  printResult({ id: itemId, written: true, updateBytes: result.bytes }, output);
}

/** Reads all of stdin as UTF-8, for `nixctl note write <id> < body.md`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
