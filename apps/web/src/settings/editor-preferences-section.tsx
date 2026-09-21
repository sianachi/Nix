import { useMobileToolbarPreference } from '../editor/mobile-toolbar-preference';
import { usePageGuidePreference } from '../editor/page-guide-preference';
import { Field, Select, Text } from '@nix/ui';
import type { ChangeEvent, ReactElement } from 'react';

import { KeyboardModeSchema, useKeyboardModeStore } from '../editor/keyboard-mode-store';

const modeGuidance = {
  standard: 'Uses the editor and platform shortcuts shown throughout Nix.',
  vim: 'Normal and Insert modes. h/l move by character; w/b/e move by language word within the current text block; 0/$ move within that block; gg/G move across the document; i/a/I/A enter Insert; Escape returns to Normal. Visual mode, j/k, operators, counts, registers, search, macros, and : commands are not included.',
  emacs:
    'Ctrl+A and Ctrl+E move to the start or end of the current text block. Ctrl+/ and Ctrl+_ undo your last local edit. Prefixes, search, visual-line movement, and kill/yank are not included.',
} as const;

export function EditorPreferencesSection(): ReactElement {
  const toolbar = useMobileToolbarPreference();
  const pageGuides = usePageGuidePreference();
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
            : `Browser storage is unavailable. ${mode === 'vim' ? 'Vim basics' : 'Emacs basics'} may reset when this page reloads.`
          : ''}
      </Text>

      <Field label="Keyboard mode" hint={modeGuidance[mode]} className="max-w-lg">
        {(control) => (
          <Select {...control} value={mode} onChange={onModeChange}>
            <option value="standard">Standard</option>
            <option value="vim">Vim basics</option>
            <option value="emacs">Emacs basics</option>
          </Select>
        )}
      </Field>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={toolbar.visibility === 'while-writing'}
          onChange={(event) => {
            toolbar.setVisibility(event.target.checked ? 'while-writing' : 'always');
          }}
        />
        <Text as="span" variant="bodySmall">
          Hide mobile tools while writing
        </Text>
      </label>
      {!toolbar.saved ? (
        <Text as="p" variant="note" role="alert">
          The mobile toolbar preference applies to this session; browser storage is unavailable.
        </Text>
      ) : null}
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={pageGuides.visibility === 'shown'}
          onChange={(event) => {
            pageGuides.setVisibility(event.target.checked ? 'shown' : 'hidden');
          }}
        />
        <Text as="span" variant="bodySmall">
          Show page guides
        </Text>
      </label>
      <Text as="p" variant="note" tone="muted">
        Draws a line where the PDF and Word exports would start a new page. The position is an
        estimate from the A4 export's margins and type size; the exact break can move by a line.
      </Text>
      {!pageGuides.saved ? (
        <Text as="p" variant="note" role="alert">
          The page guide preference applies to this session; browser storage is unavailable.
        </Text>
      ) : null}
    </section>
  );
}
