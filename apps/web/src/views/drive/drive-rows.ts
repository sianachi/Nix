import type { MenuEntry } from '@nix/ui';
import type { DragEvent } from 'react';

import type { Item } from '../core/container-model';
import type { DriveFileInfo } from './use-drive-file-info';

/** A file that is not also drawn as a folder: the rows whose picture can be a thumbnail. */
export function isFileRow(item: Item): boolean {
  return item.type === 'file' && !item.hasChildren;
}

export interface RowsProps {
  readonly rows: readonly Item[];
  readonly fileInfo: ReadonlyMap<string, DriveFileInfo>;
  readonly dropTargetRow: string | null;
  readonly onOpen: (itemId: string) => void;
  readonly rowContextMenu: (item: Item) => MenuEntry[];
  readonly onDragStart: (item: Item, event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (item: Item, event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (item: Item, event: DragEvent<HTMLElement>) => void;
}
