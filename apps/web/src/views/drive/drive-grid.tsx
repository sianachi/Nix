import { ContextMenu, Icon, Text, blueprintFrame, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatBytes } from '../../files/file-facts';
import { useOptionalItemSelection } from '../core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import { rowGestures } from '../core/use-item-selection';
import { driveKindIcon } from './drive-icons';
import { DriveFileThumbnail } from './drive-file-thumbnail';
import { isFileRow, type RowsProps } from './drive-rows';
import { kindOf } from './drive-sort';

export function DriveGrid(props: RowsProps): ReactNode {
  const {
    rows,
    fileInfo,
    dropTargetRow,
    onOpen,
    rowContextMenu,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
  } = props;
  const selection = useOptionalItemSelection();
  const openBeside = selection?.openBeside;
  const order = rows.map((item) => item.id);

  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind removes the list style, and with it this implicit role in WebKit.
    <ul
      role="list"
      aria-label="This drive's contents"
      className="grid min-w-0 grid-cols-1 gap-3 @lg/drive:grid-cols-2 @3xl/drive:grid-cols-3 @5xl/drive:grid-cols-4 @7xl/drive:grid-cols-6"
    >
      {rows.map((item) => {
        const info = fileInfo.get(item.id);
        const RowIcon = driveKindIcon(item);
        const isSelected = selection?.selected.has(item.id) === true;
        const openProps = rowGestures(
          selection,
          item.id,
          order,
          () => {
            onOpen(item.id);
          },
          openBeside === undefined
            ? undefined
            : () => {
                openBeside(item.id);
              },
        );
        return (
          <ContextMenu
            key={item.id}
            label={`${item.title || 'Untitled'} actions`}
            items={() => rowContextMenu(item)}
          >
            {(contextTarget) => (
              <li
                {...contextTarget}
                draggable
                onDragStart={(event) => {
                  onDragStart(item, event);
                }}
                onDragOver={(event) => {
                  onDragOver(item, event);
                }}
                onDragEnd={onDragEnd}
                onDrop={(event) => {
                  onDrop(item, event);
                }}
                className={cn(
                  blueprintFrame,
                  'group relative flex min-w-0 flex-col items-center gap-2 bg-surface p-3',
                  isSelected && 'bg-accent/10',
                  dropTargetRow === item.id && 'outline-2 -outline-offset-2 outline-accent',
                )}
              >
                <SelectCheckbox item={item} className="self-start" />
                {isFileRow(item) ? (
                  <DriveFileThumbnail
                    item={item}
                    info={info}
                    className="aspect-square w-full"
                    iconSize="lg"
                  />
                ) : (
                  <Icon icon={RowIcon} size="lg" />
                )}
                <button
                  type="button"
                  {...openProps}
                  className={cn('w-full min-w-0 text-center', focusRing)}
                >
                  <Text
                    variant="body"
                    as="span"
                    title={item.title || 'Untitled'}
                    className="line-clamp-2 wrap-anywhere"
                  >
                    {item.title || 'Untitled'}
                  </Text>
                </button>
                <Text variant="caption" as="span" tone="muted">
                  {item.type === 'file'
                    ? info?.status === 'ready'
                      ? formatBytes(info.record.current.byteLength)
                      : '—'
                    : kindOf(item, info)}
                </Text>
              </li>
            )}
          </ContextMenu>
        );
      })}
    </ul>
  );
}
