import { describe, expect, it } from 'vitest';

import { MAX_PASSAGES, speechPassages } from '../../lib/speech-passages';

describe('cutting text into passages to speak', () => {
  it('keeps sentences whole and fills each passage', () => {
    const passages = speechPassages('One. Two is longer! Three?\n\nFour on a new line.', 22);

    expect(passages).toEqual(['One. Two is longer!', 'Three?', 'Four on a new line.']);
  });

  it('breaks a sentence longer than a passage at a comma or a space', () => {
    const long = `${'alpha '.repeat(8)}beta, ${'gamma '.repeat(8)}end.`;

    const passages = speechPassages(long, 60);

    expect(passages.length).toBeGreaterThan(1);
    expect(passages.every((passage) => passage.length <= 60)).toBe(true);
    expect(passages.join(' ')).toBe(long.replace(/\s+/gu, ' '));
  });

  it('cuts an unbroken run where it stands and gives nothing for nothing', () => {
    expect(speechPassages('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'xxxxx']);
    expect(speechPassages('  \n\t ')).toEqual([]);
  });

  it('keeps the first passage short so the voice starts soon', () => {
    const sentence = 'This sentence is about fifty characters in length. ';

    const passages = speechPassages(sentence.repeat(20));

    expect(passages[0]?.length).toBeLessThanOrEqual(160);
    expect(passages[1]?.length).toBeGreaterThan(400);
    expect(passages.join(' ')).toBe(sentence.repeat(20).trim());
  });

  it('stops at what one reading takes on', () => {
    const text = Array.from(
      { length: MAX_PASSAGES + 30 },
      (_, index) => `Sentence ${String(index)}.`,
    ).join(' ');

    expect(speechPassages(text, 14)).toHaveLength(MAX_PASSAGES);
  });
});
