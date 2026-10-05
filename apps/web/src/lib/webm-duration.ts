/**
 * Writes the length of a recording into the front of a WebM file that does not say it.
 *
 * A browser's recorder streams WebM out as it goes, so the header is written before anybody knows
 * how long the recording will be and the Duration element is simply left out. A player handed such
 * a file reports an infinite length and cannot seek. Everything needed to fix that sits in the
 * first few hundred bytes: the Segment's Info element, which gains (or has overwritten) a
 * Duration. Only that head is rewritten; the audio after it is untouched.
 *
 * Returns null whenever the bytes are not the shape a recorder writes - no EBML header, no Info
 * inside the bytes given, a Segment with a declared size that inserting bytes would falsify - so
 * a caller keeps the original file rather than a damaged one.
 */

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
/** Matroska's default tick: a millisecond, in nanoseconds. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

interface Element {
  readonly id: number;
  /** Where the size field starts, and how many bytes it takes. */
  readonly sizeAt: number;
  readonly sizeLength: number;
  /** Null when the size is the reserved "unknown" value a streamed Segment carries. */
  readonly size: number | null;
  readonly dataAt: number;
}

function vintLength(first: number): number {
  for (let length = 1; length <= 8; length += 1) {
    if ((first & (0x80 >> (length - 1))) !== 0) return length;
  }
  return 0;
}

function readElement(bytes: Uint8Array, at: number): Element | null {
  const idLength = vintLength(bytes[at] ?? 0);
  if (idLength === 0 || idLength > 4 || at + idLength >= bytes.length) return null;
  let id = 0;
  for (let index = 0; index < idLength; index += 1) id = id * 256 + (bytes[at + index] ?? 0);

  const sizeAt = at + idLength;
  const first = bytes[sizeAt] ?? 0;
  const sizeLength = vintLength(first);
  if (sizeLength === 0 || sizeAt + sizeLength > bytes.length) return null;
  let size = first & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let index = 1; index < sizeLength; index += 1) {
    const byte = bytes[sizeAt + index] ?? 0;
    if (byte !== 0xff) unknown = false;
    size = size * 256 + byte;
  }
  return { id, sizeAt, sizeLength, size: unknown ? null : size, dataAt: sizeAt + sizeLength };
}

type SizedElement = Element & { readonly size: number };

/** An element whose size is declared, which is every element but a streamed Segment or Cluster. */
function readSized(bytes: Uint8Array, at: number): SizedElement | null {
  const element = readElement(bytes, at);
  const size = element?.size ?? null;
  return element === null || size === null ? null : { ...element, size };
}

function readUnsigned(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + (bytes[at + index] ?? 0);
  return value;
}

function writeSize(target: Uint8Array, at: number, length: number, size: number): boolean {
  // The all-ones pattern means "unknown", so the largest writable value is one below it.
  if (size >= 2 ** (7 * length) - 1) return false;
  let rest = size;
  for (let index = length - 1; index >= 0; index -= 1) {
    target[at + index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  target[at] = (target[at] ?? 0) | (0x80 >> (length - 1));
  return true;
}

export function withWebmDuration(
  head: Uint8Array,
  durationMs: number,
): Uint8Array<ArrayBuffer> | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

  const header = readSized(head, 0);
  if (header?.id !== EBML_HEADER) return null;
  const segment = readElement(head, header.dataAt + header.size);
  if (segment?.id !== SEGMENT) return null;

  let at = segment.dataAt;
  let info: SizedElement | null = null;
  while (at < head.length) {
    const element = readSized(head, at);
    if (element === null) return null;
    if (element.id === INFO) {
      info = element;
      break;
    }
    at = element.dataAt + element.size;
  }
  if (info === null) return null;
  const infoEnd = info.dataAt + info.size;
  if (infoEnd > head.length) return null;

  let scale = DEFAULT_TIMECODE_SCALE;
  let existing: SizedElement | null = null;
  for (let child = info.dataAt; child < infoEnd;) {
    const element = readSized(head, child);
    if (element === null) return null;
    if (element.id === TIMECODE_SCALE) scale = readUnsigned(head, element.dataAt, element.size);
    if (element.id === DURATION) existing = element;
    child = element.dataAt + element.size;
  }
  if (scale <= 0) return null;
  const ticks = (durationMs * 1_000_000) / scale;

  if (existing !== null) {
    const patched = head.slice();
    const view = new DataView(patched.buffer);
    if (existing.size === 8) view.setFloat64(existing.dataAt, ticks);
    else if (existing.size === 4) view.setFloat32(existing.dataAt, ticks);
    else return null;
    return patched;
  }

  // Inserting bytes moves everything after Info, which is only honest when the Segment does not
  // claim a size of its own.
  if (segment.size !== null) return null;
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, ticks);

  const patched = new Uint8Array(head.length + duration.length);
  patched.set(head.subarray(0, infoEnd), 0);
  patched.set(duration, infoEnd);
  patched.set(head.subarray(infoEnd), infoEnd + duration.length);
  patched.fill(0, info.sizeAt, info.sizeAt + info.sizeLength);
  if (!writeSize(patched, info.sizeAt, info.sizeLength, info.size + duration.length)) return null;
  return patched;
}
