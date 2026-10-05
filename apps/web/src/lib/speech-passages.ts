/**
 * Cuts text into passages short enough to be spoken one request at a time.
 *
 * Speech is asked for a passage at a time so the first one can be playing while the rest is
 * still being made, and so no single request is long. A passage ends at a sentence end wherever
 * there is one, because a voice that stops for breath mid-clause is the thing people notice.
 */

/** Comfortably under the speech worker's limit for one request. */
export const PASSAGE_CHARACTERS = 600;
/**
 * The first passage is kept this short. Nothing is heard until it has been made, and a voice that
 * starts after a second reads as an answer where one that starts after six reads as a fault.
 */
export const LEAD_CHARACTERS = 160;
/** What one "read aloud" will take on: about an hour of speech. */
export const MAX_PASSAGES = 120;

function splitLong(sentence: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    // The last comma or space inside the limit; a single unbroken run is cut where it stands.
    const window = rest.slice(0, limit + 1);
    const comma = window.lastIndexOf(', ');
    const space = window.lastIndexOf(' ');
    const at = comma > limit / 2 ? comma + 1 : space > 0 ? space : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

export function speechPassages(text: string, limit = PASSAGE_CHARACTERS): string[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((sentence) => sentence.replace(/\s+/gu, ' ').trim())
    .filter((sentence) => sentence !== '')
    .flatMap((sentence) => splitLong(sentence, limit));

  const passages: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const room = passages.length === 0 ? Math.min(limit, LEAD_CHARACTERS) : limit;
    if (current !== '' && current.length + 1 + sentence.length > room) {
      passages.push(current);
      current = '';
    }
    current = current === '' ? sentence : `${current} ${sentence}`;
  }
  if (current !== '') passages.push(current);
  return passages.slice(0, MAX_PASSAGES);
}
