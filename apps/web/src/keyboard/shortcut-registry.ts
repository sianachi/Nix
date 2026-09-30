import type { Shortcut } from '../lib/shortcuts';

/**
 * Every keyboard shortcut the application offers, in one list the shortcut sheet reads.
 *
 * `handledBy: 'shell'` entries are the ones `useShellShortcuts` listens for itself; the rest are
 * handled where they apply (a tab, a tree row, the pane frame) and are listed here so the sheet is
 * the complete answer to "what can I do from the keyboard?" rather than half of it.
 */
export type ShellShortcutId =
  'search' | 'new-note' | 'toggle-sidebar' | 'back' | 'forward' | 'shortcuts';

type Group = 'General' | 'Panes and tabs' | 'Workspace tree';

interface Entry {
  readonly label: string;
  readonly group: Group;
  /** One or more chords that do the same thing. */
  readonly keys: readonly Shortcut[];
}

/** A shortcut the shell listens for itself. */
export interface ShellShortcut extends Entry {
  readonly handledBy: 'shell';
  readonly id: ShellShortcutId;
  /**
   * Whether it still fires from a text field or editable content. Chords of the command key do
   * - Search from inside a note is the point of it - but history keys and bare characters are
   * things people type there, so they are left to the typist.
   */
  readonly whileTyping: boolean;
}

/** A shortcut handled where it applies, listed so the sheet is the complete answer. */
export interface LocalShortcut extends Entry {
  readonly handledBy: 'local';
}

export type ShortcutEntry = ShellShortcut | LocalShortcut;

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'search',
    label: 'Search and commands',
    group: 'General',
    keys: [{ key: 'k', code: 'KeyK', mod: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  {
    id: 'new-note',
    label: 'New note',
    group: 'General',
    // Not Ctrl+N: the browser keeps that chord for a new window and never passes it to a page.
    keys: [{ key: 'n', code: 'KeyN', mod: true, alt: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  {
    id: 'toggle-sidebar',
    label: 'Show or hide the sidebar',
    group: 'General',
    keys: [{ key: '\\', code: 'Backslash', mod: true }],
    handledBy: 'shell',
    whileTyping: true,
  },
  // An installed window has no Back button of its own; these are the platform's history keys.
  {
    id: 'back',
    label: 'Go back',
    group: 'General',
    keys: [{ key: '[', code: 'BracketLeft', mod: true }],
    handledBy: 'shell',
    whileTyping: false,
  },
  {
    id: 'forward',
    label: 'Go forward',
    group: 'General',
    keys: [{ key: ']', code: 'BracketRight', mod: true }],
    handledBy: 'shell',
    whileTyping: false,
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    group: 'General',
    keys: [{ key: '/', code: 'Slash', mod: true }, { key: '?' }],
    handledBy: 'shell',
    whileTyping: false,
  },
  {
    label: 'Actions for the focused row, tab or card',
    group: 'General',
    keys: [{ key: 'F10', shift: true }, { key: 'ContextMenu' }],
    handledBy: 'local',
  },
  { label: 'Next pane', group: 'Panes and tabs', keys: [{ key: 'F6' }], handledBy: 'local' },
  {
    label: 'Previous pane',
    group: 'Panes and tabs',
    keys: [{ key: 'F6', shift: true }],
    handledBy: 'local',
  },
  {
    label: 'Close the focused tab',
    group: 'Panes and tabs',
    keys: [{ key: 'Delete' }, { key: 'Backspace' }],
    handledBy: 'local',
  },
  {
    label: 'Open the focused row beside',
    group: 'Workspace tree',
    keys: [{ key: 'Enter', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move up among its siblings',
    group: 'Workspace tree',
    keys: [{ key: 'ArrowUp', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move down among its siblings',
    group: 'Workspace tree',
    keys: [{ key: 'ArrowDown', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move inside the row above',
    group: 'Workspace tree',
    keys: [{ key: 'ArrowRight', alt: true }],
    handledBy: 'local',
  },
  {
    label: 'Move out of its parent',
    group: 'Workspace tree',
    keys: [{ key: 'ArrowLeft', alt: true }],
    handledBy: 'local',
  },
];

export function shortcutFor(id: ShellShortcutId): ShellShortcut {
  const entry = SHORTCUTS.find(
    (candidate): candidate is ShellShortcut =>
      candidate.handledBy === 'shell' && candidate.id === id,
  );
  if (entry === undefined) throw new Error(`No shortcut is registered for ${id}.`);
  return entry;
}
