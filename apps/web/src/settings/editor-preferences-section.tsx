import { useGhostTextPreference } from '../editor/ghost-text-preference';
import { useMentionPreference } from '../editor/mention-preference';
import { useMobileToolbarPreference } from '../editor/mobile-toolbar-preference';
import { usePageGuidePreference } from '../editor/page-guide-preference';
import { Field, Select, Text } from '@nix/ui';
import { useId, type ChangeEvent, type ReactElement } from 'react';

import { KeyboardModeSchema, useKeyboardModeStore } from '../editor/keyboard-mode-store';
import { LINK_MENTION_SHORTCUT } from '../keyboard/shortcut-registry';
import { formatShortcut } from '../lib/shortcuts';
import { useChoiceOrderPreference, useViewSuggestionPreference } from './suggestion-preferences';

const modeGuidance = {
  standard: 'Uses the editor and platform shortcuts shown throughout Nix.',
  vim: 'Normal and Insert modes. h/l move by character; w/b/e move by language word within the current text block; 0/$ move within that block; gg/G move across the document; i/a/I/A enter Insert; Escape returns to Normal. Visual mode, j/k, operators, counts, registers, search, macros, and : commands are not included.',
  emacs:
    'Ctrl+A and Ctrl+E move to the start or end of the current text block. Ctrl+/ and Ctrl+_ undo your last local edit. Prefixes, search, visual-line movement, and kill/yank are not included.',
} as const;

export function EditorPreferencesSection(): ReactElement {
  const toolbarVisibility = useMobileToolbarPreference((state) => state.visibility);
  const toolbarSaved = useMobileToolbarPreference((state) => state.saved);
  const setToolbarVisibility = useMobileToolbarPreference((state) => state.setVisibility);
  const pageGuideVisibility = usePageGuidePreference((state) => state.visibility);
  const pageGuideSaved = usePageGuidePreference((state) => state.saved);
  const setPageGuideVisibility = usePageGuidePreference((state) => state.setVisibility);
  const phraseSetting = useGhostTextPreference((state) => state.setting);
  const phraseSaved = useGhostTextPreference((state) => state.saved);
  const setPhraseSetting = useGhostTextPreference((state) => state.setSetting);
  const mentionSetting = useMentionPreference((state) => state.setting);
  const mentionSaved = useMentionPreference((state) => state.saved);
  const setMentionSetting = useMentionPreference((state) => state.setSetting);
  const viewSetting = useViewSuggestionPreference((state) => state.setting);
  const viewSaved = useViewSuggestionPreference((state) => state.saved);
  const setViewSetting = useViewSuggestionPreference((state) => state.setSetting);
  const choiceSetting = useChoiceOrderPreference((state) => state.setting);
  const choiceSaved = useChoiceOrderPreference((state) => state.saved);
  const setChoiceSetting = useChoiceOrderPreference((state) => state.setSetting);
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
      <PreferenceToggle
        label="Hide mobile tools while writing"
        checked={toolbarVisibility === 'while-writing'}
        onChange={(checked) => {
          setToolbarVisibility(checked ? 'while-writing' : 'always');
        }}
        description="On a phone, the formatting tools collapse once you start typing in a note."
        unsaved={
          toolbarSaved
            ? null
            : 'The mobile toolbar preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Show page guides"
        checked={pageGuideVisibility === 'shown'}
        onChange={(checked) => {
          setPageGuideVisibility(checked ? 'shown' : 'hidden');
        }}
        description="Draws a line where the PDF and Word exports would start a new page. The position is an estimate from the A4 export’s margins and type size; the exact break can move by a line."
        unsaved={
          pageGuideSaved
            ? null
            : 'The page guide preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Suggest phrase completions"
        checked={phraseSetting === 'on'}
        onChange={(checked) => {
          setPhraseSetting(checked ? 'on' : 'off');
        }}
        description={`After a pause in typing at the end of a line, shows a likely ending for what you are writing in faded italic text. Press Right Arrow to accept it or Escape to dismiss it; it is not part of the note until you accept it. Needs a keyboard. Learned on this device, in memory only, from notes in the same workspace that this browser already keeps.`}
        unsaved={
          phraseSaved
            ? null
            : 'The phrase suggestion preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Underline item names that are not linked"
        checked={mentionSetting === 'on'}
        onChange={(checked) => {
          setMentionSetting(checked ? 'on' : 'off');
        }}
        description={`After a pause in typing, item titles from this workspace that appear in a note without a link get a dotted underline. Put the caret in one and press ${formatShortcut(LINK_MENTION_SHORTCUT)}, or choose Link to, to turn it into a link. Nothing changes in the note until you do.`}
        unsaved={
          mentionSaved
            ? null
            : 'The underline preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Suggestions in views"
        checked={viewSetting === 'on'}
        onChange={(checked) => {
          setViewSetting(checked ? 'on' : 'off');
        }}
        description="Hints a view offers on its own: likely values when you create an item, a note on cards that have not moved in a while, the spreadsheet’s fill-series offer, a free time when rescheduling, and a form field’s usual value. Nothing is written until you choose one."
        unsaved={
          viewSaved
            ? null
            : 'The view suggestion preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Order choices by what I pick most"
        checked={choiceSetting === 'on'}
        onChange={(checked) => {
          setChoiceSetting(checked ? 'on' : 'off');
        }}
        description="Remembers what you pick on this device: a select property offers your usual values again in a Recent group above its options, and the slash menu and link picker list what you use most first. Off, nothing new is remembered and every list keeps its usual order."
        unsaved={
          choiceSaved
            ? null
            : 'The choice order preference applies to this session; browser storage is unavailable.'
        }
      />
    </section>
  );
}

/**
 * One on/off preference: a checkbox named by its label and described by the note under it, so a
 * screen reader hears what the switch covers when it lands on it, not only after reading on.
 */
function PreferenceToggle(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly description: string;
  readonly unsaved: string | null;
}): ReactElement {
  const descriptionId = useId();
  return (
    <>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          checked={props.checked}
          aria-describedby={descriptionId}
          onChange={(event) => {
            props.onChange(event.target.checked);
          }}
        />
        <Text as="span" variant="bodySmall">
          {props.label}
        </Text>
      </label>
      <Text as="p" id={descriptionId} variant="note" tone="muted">
        {props.description}
      </Text>
      {props.unsaved === null ? null : (
        <Text as="p" variant="note" role="alert">
          {props.unsaved}
        </Text>
      )}
    </>
  );
}
