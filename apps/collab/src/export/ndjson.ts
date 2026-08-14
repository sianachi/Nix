import type { ArchiveManifest, ItemBundle } from '@nix/export';

/**
 * The bundle stream, as newline-delimited JSON.
 *
 * ```
 * {"format":"nix-archive",...}     the manifest, always the first line
 * {"id":"...","body":{...}}        one bundle per line, in the manifest's order
 * {"end":true,"items":37}          the sentinel, always the last line
 * ```
 *
 * **Why NDJSON.** A streamed JSON array makes the writer emit `[`, `,` and `]` by hand and forces
 * the reader to run an incremental parser; multipart needs boundary generation and a MIME parser on
 * both sides. This is one `JSON.parse` per line and no library at either end. It also reproduces
 * `writeArchive`'s own ordering - manifest first, payloads after - so the two consumers of the same
 * traversal read it the same way rather than drifting.
 *
 * **The framing is safe because `JSON.stringify` escapes newlines inside strings.** A document
 * whose text contains a line break serialises to `\n` as two characters, never a literal one, so
 * document content can never split a line. That is the load-bearing assumption; if the encoder
 * below is ever replaced, it is the property the replacement has to keep.
 *
 * **The sentinel is not decoration.** A truncated NDJSON stream is still a sequence of valid JSON
 * lines, so a reader without one would accept a short stream as a complete export and produce a
 * plausible, silently incomplete PDF. `writeArchive` makes the same argument for refusing to close
 * a zip around a missing payload; the argument is stronger here, because a zip at least fails to
 * open.
 */

export const STREAM_MEDIA_TYPE = 'application/x-ndjson';

/** The last line of a well-formed stream. A reader that does not see it must refuse what it read. */
export interface StreamEnd {
  readonly end: true;

  /** How many bundles were written, so a reader can check it got them all. */
  readonly items: number;
}

export async function* writeBundleStream(input: {
  readonly manifest: ArchiveManifest;
  readonly bundles: AsyncIterable<ItemBundle>;
}): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();

  yield encoder.encode(line(input.manifest));

  let written = 0;

  for await (const bundle of input.bundles) {
    written += 1;
    yield encoder.encode(line(bundle));
  }

  const end: StreamEnd = { end: true, items: written };
  yield encoder.encode(line(end));
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
