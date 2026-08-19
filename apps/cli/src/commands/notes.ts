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
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

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
