import { Button, Textarea } from '@nix/ui';
import { useEffect, useRef, type ReactElement } from 'react';
import { composerRows } from '../composer/composer-rows';

/** The last user message, edited where it sits. Enter sends (Shift+Enter breaks the line on a
 * keyboard), Escape cancels; focus lands in the field when it opens. */
export function PetMessageEditor({
  text,
  enterToSend,
  busy,
  onChange,
  onSend,
  onCancel,
}: {
  readonly text: string;
  readonly enterToSend: boolean;
  /** A turn is running: sending is off until it ends. */
  readonly busy: boolean;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Textarea
        ref={field}
        aria-label="Edit your message"
        rows={composerRows(text)}
        maxLength={8000}
        value={text}
        resize="none"
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter' && enterToSend && !event.shiftKey && text.trim() && !busy) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" disabled={!text.trim() || busy} onClick={onSend}>
          Resend
        </Button>
      </div>
    </div>
  );
}
