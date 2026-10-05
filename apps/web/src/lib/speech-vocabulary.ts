/**
 * Names the person is likely to say, offered to the recogniser as a spelling hint.
 *
 * Dictation hears "ada lovelace" and has to decide how to write it; the titles in the workspace
 * are the best evidence there is. The shell keeps this list current from the tree it already
 * holds, and dictation reads it when a clip is sent. It is a hint and nothing more: bounded,
 * kept in memory only, and gone on sign-out with the rest of the session.
 */

/** The speech worker refuses a longer hint. */
export const MAX_HINT_CHARACTERS = 400;

let hint = '';

export function rememberSpeechVocabulary(titles: readonly string[]): void {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const raw of titles) {
    const title = raw.replace(/\s+/gu, ' ').trim();
    const key = title.toLowerCase();
    // Placeholders teach the recogniser nothing, and one long title must not crowd out the rest.
    if (title === '' || title.length > 60 || key.startsWith('untitled') || seen.has(key)) continue;
    if (length + title.length + 2 > MAX_HINT_CHARACTERS) break;
    seen.add(key);
    kept.push(title);
    length += title.length + 2;
  }
  hint = kept.join(', ');
}

export function speechVocabularyHint(): string {
  return hint;
}

export function clearSpeechVocabulary(): void {
  hint = '';
}
