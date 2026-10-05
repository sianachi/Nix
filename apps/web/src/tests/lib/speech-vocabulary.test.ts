import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_HINT_CHARACTERS,
  clearSpeechVocabulary,
  rememberSpeechVocabulary,
  speechVocabularyHint,
} from '../../lib/speech-vocabulary';

afterEach(() => {
  clearSpeechVocabulary();
});

describe('the names offered to dictation', () => {
  it('keeps distinct, real titles and drops placeholders', () => {
    rememberSpeechVocabulary([
      'Ada  Lovelace',
      'Untitled note',
      'ada lovelace',
      '',
      'Quarterly review',
      'x'.repeat(61),
    ]);

    expect(speechVocabularyHint()).toBe('Ada Lovelace, Quarterly review');
  });

  it('stays within what the speech worker accepts', () => {
    rememberSpeechVocabulary(
      Array.from({ length: 200 }, (_, index) => `Project number ${String(index)}`),
    );

    expect(speechVocabularyHint().length).toBeLessThanOrEqual(MAX_HINT_CHARACTERS);
    expect(speechVocabularyHint()).toContain('Project number 0');
  });

  it('is forgotten on request', () => {
    rememberSpeechVocabulary(['Ada Lovelace']);
    clearSpeechVocabulary();

    expect(speechVocabularyHint()).toBe('');
  });
});
