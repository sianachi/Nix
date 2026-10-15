/** Reassembles adjacent storage chunks without combining older, standalone message rows. */
export function chatTranscript(rows: readonly Readonly<Record<string, unknown>>[]): {
  role: string;
  text: string;
  createdAt: string;
}[] {
  const messages: { role: string; text: string; createdAt: string }[] = [];
  let previousId: string | null = null;
  for (const properties of rows) {
    const id =
      typeof properties.chat_message_id === 'string' && properties.chat_message_id.length > 0
        ? properties.chat_message_id
        : null;
    const role = typeof properties.chat_role === 'string' ? properties.chat_role : 'Message';
    const content =
      typeof properties.chat_text === 'string'
        ? properties.chat_text
        : '[Message text unavailable]';
    const previous = messages.at(-1);
    if (id !== null && id === previousId && previous?.role === role) {
      previous.text += content;
    } else {
      messages.push({
        role,
        text: content,
        createdAt: typeof properties.chat_created_at === 'string' ? properties.chat_created_at : '',
      });
    }
    previousId = id;
  }
  return messages;
}
