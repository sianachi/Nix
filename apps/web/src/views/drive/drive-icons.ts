import { File, FileText, Folder, PenTool, Sheet, type LucideIcon } from 'lucide-react';

import type { Item } from '../core/container-model';

/**
 * The glyph a drive row leads with.
 *
 * Chosen from what the item actually is, in this order: whether it holds children, then its own
 * body kind. **Container first, body second** - issue #54's whole point is that a drive is a view
 * over a container's children rather than a folder being a kind of item, so what makes a row read
 * as "a folder" here is that it holds more children, not what its own body happens to be. A note
 * with children still draws as a folder; a note without draws as a note.
 */
export function driveKindIcon(item: Item): LucideIcon {
  if (item.hasChildren) return Folder;

  switch (item.type) {
    case 'file':
      return File;
    case 'spreadsheet':
      return Sheet;
    case 'canvas':
      return PenTool;
    case 'note':
      return FileText;
    default:
      // An unrecognised body kind is still a document of some sort, and a generic text glyph says
      // that honestly rather than guessing at a more specific one.
      return FileText;
  }
}

/**
 * The word a person sees in a body kind's own name.
 *
 * Not used for files, which name themselves after their extension instead (see `drive-file-info`) -
 * "kind" for a file means what is inside it, and an item's body kind ("file") says nothing about
 * that.
 */
export function driveBodyKindLabel(type: string): string {
  switch (type) {
    case 'note':
      return 'Note';
    case 'canvas':
      return 'Canvas';
    case 'spreadsheet':
      return 'Spreadsheet';
    case 'file':
      return 'File';
    default:
      return type.length === 0 ? 'Item' : type.slice(0, 1).toUpperCase() + type.slice(1);
  }
}

/** Whether a child can hold the sort of thing a "move into" destination has to be. */
export function isDriveContainerCandidate(item: Item): boolean {
  // Every item can in principle hold children, but the drive only offers what already reads as a
  // destination: something that already has children, or something whose body is not a file (a
  // file cannot itself hold children, so it is never a candidate no matter what it says about
  // `hasChildren`).
  return item.hasChildren || item.type !== 'file';
}
