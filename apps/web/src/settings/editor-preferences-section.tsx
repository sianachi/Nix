import { Field, Select, Text } from '@nix/ui';
import type { ChangeEvent, ReactElement } from 'react';

import { KeyboardModeSchema, useKeyboardModeStore } from '../editor/keyboard-mode-store';

const modeGuidance = {
  standard: 'Uses the editor and platform shortcuts shown throughout Nix.',
  emacs:
    'Ctrl+A and Ctrl+E move to the start or end of the current text block. Ctrl+/ and Ctrl+_ undo your last local edit. Prefixes, search, visual-line movement, and kill/yank are not included.',
} as const;

export function EditorPreferencesSection(): ReactElement {
  const mode = useKeyboardModeStore((state) => state.mode);
  const persistence = useKeyboardModeStore((state) => state.persistence);
  const keyboardModeSelected = useKeyboardModeStore((state) => state.keyboardModeSelected);

  function onModeChange(event: ChangeEvent<HTMLSelectElement>): void {
    const parsed = KeyboardModeSchema.safeParse(event.currentTarget.value);
    if (!parsed.success) {
      console.warn('Ignoring an unrecognised editor keyboard mode selection.');
      return;
    }
    keyboardModeSelected(parsed.data);
  }

  return (
    <section aria-labelledby="editor-preferences-heading" className="flex flex-col gap-3">
      <Text id="editor-preferences-heading" variant="h3" as="h2">
        Editor
      </Text>
      <Text variant="note" tone="muted">
        Personal note-body preferences. They are stored only in this browser, do not sync to your
        account, and never change the shared document.
      </Text>

      <Text
        variant="note"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={persistence === 'stored' ? 'sr-only' : ''}
      >
        {persistence === 'session-only'
          ? mode === 'standard'
            ? 'Browser storage is unavailable. Standard remains the default; another choice may reset when this page reloads.'
            : 'Browser storage is unavailable. Emacs basics may reset when this page reloads.'
          : ''}
      </Text>

      <Field label="Keyboard mode" hint={modeGuidance[mode]} className="max-w-lg">
        {(control) => (
          <Select {...control} value={mode} onChange={onModeChange}>
            <option value="standard">Standard</option>
            <option value="emacs">Emacs basics</option>
          </Select>
        )}
      </Field>
    </section>
  );
}
