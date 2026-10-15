import { describe, expect, it } from 'vitest';
import { chatTranscript } from './chat.js';

describe('chatTranscript', () => {
  it('joins adjacent chunks into a complete message and keeps legacy rows separate', () => {
    const beginning = 'x'.repeat(3000);
    expect(
      chatTranscript([
        { chat_role: 'assistant', chat_message_id: 'a', chat_part: 0, chat_text: beginning },
        { chat_role: 'assistant', chat_message_id: 'a', chat_part: 1, chat_text: '<end>' },
        { chat_role: 'user', chat_text: 'first' },
        { chat_role: 'user', chat_text: 'second' },
      ]),
    ).toEqual([
      { role: 'assistant', text: beginning + '<end>', createdAt: '' },
      { role: 'user', text: 'first', createdAt: '' },
      { role: 'user', text: 'second', createdAt: '' },
    ]);
  });

  it('does not join nonadjacent message IDs or different roles', () => {
    const rows = [
      { chat_role: 'assistant', chat_message_id: 'a', chat_text: 'one' },
      { chat_role: 'user', chat_message_id: 'a', chat_text: 'two' },
      { chat_role: 'user', chat_message_id: 'b', chat_text: 'three' },
      { chat_role: 'user', chat_message_id: 'a', chat_text: 'four' },
    ];
    expect(chatTranscript(rows).map((message) => message.text)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
  });
});
