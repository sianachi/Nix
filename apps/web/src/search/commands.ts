import { FilePlus, PanelLeft, type LucideIcon } from 'lucide-react';

/**
 * What the palette can do, as opposed to what it can find.
 *
 * **A registry rather than a literal list**, because MVP-2.9's Q3 names "a command in the palette"
 * as one of the closed set of extension points a plugin may use. A plugin contributing a command
 * has to be able to hand over exactly this shape; writing the commands as an array a component
 * closes over would mean discovering that later and rewriting the palette to accept them.
 *
 * `keywords` exist for the same reason the slash menu's do: people type the word they know rather
 * than the word the interface uses. Somebody looking for the sidebar types "hide", "collapse" or
 * "sidebar", and all three have to find it.
 */

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  readonly run: () => void;
}

/**
 * What a command needs from the shell to do its work.
 *
 * Passed in rather than reached for, because the shell is the one holder of each of these. The
 * theme is the reason this matters and is deliberately absent: `useTheme` keeps its choice in
 * component state, so a palette that called it would own a second copy and drift from the profile
 * menu's the moment either was used. Adding the command means giving the preference one owner
 * first, which is a change to the theme and not to the palette.
 */
export interface CommandContext {
  readonly createItem: () => void;
  readonly toggleSidebar: () => void;
}

/** The commands this build ships. */
export function builtInCommands(context: CommandContext): readonly PaletteCommand[] {
  return [
    {
      id: 'new-note',
      label: 'New note',
      hint: 'In the current workspace',
      icon: FilePlus,
      keywords: ['new', 'note', 'create', 'add', 'document'],
      run: context.createItem,
    },
    {
      id: 'toggle-sidebar',
      label: 'Show or hide the sidebar',
      icon: PanelLeft,
      keywords: ['sidebar', 'tree', 'hide', 'show', 'collapse', 'expand', 'navigation'],
      run: context.toggleSidebar,
    },
  ];
}

/** Filters commands the way a person typing expects: label first, then the words they might use. */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return commands;
  }

  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}
