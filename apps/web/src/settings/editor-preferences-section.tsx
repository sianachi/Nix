import { useGhostTextPreference } from '../editor/ghost-text-preference';
import { useMentionPreference } from '../editor/mention-preference';
import { useMobileToolbarPreference } from '../editor/mobile-toolbar-preference';
import { usePageGuidePreference } from '../editor/page-guide-preference';
import { Button, Field, Select, Text } from '@nix/ui';
import { useState, type ChangeEvent, type ReactElement } from 'react';

import { announce } from '../a11y/announcer';
import { useSessionStore } from '../auth/session-store';
import { PreferenceToggle } from './preference-toggle';
import { useOfflinePreference } from '../offline/offline-preference';
import { requestOfflineSync } from '../offline/offline-runtime';
import { rememberOfflineAccount } from '../offline/offline-store';
import { KeyboardModeSchema, useKeyboardModeStore } from '../editor/keyboard-mode-store';
import { LINK_MENTION_SHORTCUT } from '../keyboard/shortcut-registry';
import { formatShortcut } from '../lib/shortcuts';
import { clearSuggestionDismissals } from '../lib/suggestion-dismissals';
import { useChoiceOrderPreference, useViewSuggestionPreference } from './suggestion-preferences';

const modeGuidance = {
  standard: 'Uses the editor and platform shortcuts shown throughout Nix.',
  vim: 'Normal, Insert, Visual (v) and Visual Line (V) modes; each paragraph, heading or list item is a line. Motions: h/l by character, j/k by line, w/b/e by word, 0/^/$ within the line, gg/G across the document, all with counts. Operators d, c and y take a motion or double for whole lines (dd, cc, yy); x, X, D and C are their shorthands; p/P paste; o/O open a line; i/a/I/A enter Insert; u and Ctrl+R undo and redo your own edits. Not included: the . repeat, named registers, text objects, search, marks, macros and : commands.',
  emacs:
    'Ctrl+F/B and Alt+F/B move by character and word; Ctrl+A/E to the start or end of the paragraph; Ctrl+N/P by displayed line; Alt+< and Alt+> to either end of the note. Ctrl+Space sets the mark and Ctrl+G clears it. Ctrl+D deletes a character; Ctrl+K, Alt+D and Ctrl+W kill, Alt+W copies, and Ctrl+Y and Alt+Y yank from the kill ring. Ctrl+/ undoes and Ctrl+? redoes your own edits. These chords replace the editor and browser shortcuts they share a key with; on Windows and Linux the browser keeps Ctrl+N and Ctrl+W. Prefixes and search are not included.',
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
  const offlineEnabled = useOfflinePreference((state) => state.enabled);
  const offlineSaved = useOfflinePreference((state) => state.saved);
  const setOfflineEnabled = useOfflinePreference((state) => state.setEnabled);
  const sessionProfile = useSessionStore((state) => state.profile);
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
        Personal note-body preferences. They follow your account across devices, apply at once on
        this one even offline, and never change the shared document. Rows marked This device only
        stay in this browser.
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
        description="Remembers what you pick on this device: a select property offers your usual values again in a Recent group above its options, and the slash menu and link picker list what you use most first. Off, nothing new is remembered and nothing is reordered by what you have picked."
        unsaved={
          choiceSaved
            ? null
            : 'The choice order preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Keep notes on this device"
        deviceOnly
        checked={offlineEnabled}
        onChange={(checked) => {
          setOfflineEnabled(checked);
          if (checked && sessionProfile !== null) {
            void rememberOfflineAccount(sessionProfile).then(requestOfflineSync, () => undefined);
          }
        }}
        description="Syncs your unlocked notes to this browser so they open offline, and shows the sync status at the foot of the window. Off hides that status and stops syncing; notes already saved here stay until you clear them from Notes on this device."
        unsaved={
          offlineSaved
            ? null
            : 'The device sync preference applies to this session; browser storage is unavailable.'
        }
      />
      <PreferenceToggle
        label="Hide mobile tools while writing"
        deviceOnly
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
      <ClearDismissedSuggestions />
    </section>
  );
}

/**
 * Brings back every suggestion waved away on this browser - mentions marked "Don't suggest this",
 * dismissed stale-card notes - which is what the dismissal announcement points to.
 */
const CLEARED = 'Dismissed suggestions cleared.';

function ClearDismissedSuggestions(): ReactElement {
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        onClick={() => {
          const message = clearSuggestionDismissals()
            ? CLEARED
            : 'Browser storage could not clear dismissed suggestions. Try again.';
          setResult(message);
          announce(message);
        }}
      >
        Clear dismissed suggestions
      </Button>
      {result !== null ? (
        <Text as="p" variant="note" tone="muted">
          {result}
        </Text>
      ) : null}
    </div>
  );
}
