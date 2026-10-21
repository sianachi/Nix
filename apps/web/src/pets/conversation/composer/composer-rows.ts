/** The composer's textarea grows with its content between one and six rows, rather than
 * scrolling internally past a fixed height. Counting hard line breaks is a close enough
 * approximation of wrapped-line count for a message box this size, without measuring layout. */
export function composerRows(text: string): number {
  const lines = text.split('\n').length;
  return Math.min(6, Math.max(1, lines));
}
