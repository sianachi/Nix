import { Blueprint, Button, ContextMenu, Menu, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import { readPropertyText, type Item, type PropertyDefinition } from '../core/container-model';
import { useItemOpenProps } from '../core/item-open-click';
import { useItemContextActions } from '../core/use-item-context-actions';
import { cellValue, type CellAddress } from './matrix-axes';

export interface CellChoice {
  readonly address: CellAddress;
  readonly label: string;
}

export interface MatrixCardProps {
  readonly item: Item;
  readonly current: CellAddress;
  readonly cells: readonly CellChoice[];
  readonly fields: readonly PropertyDefinition[];
  readonly dragging: boolean;
  readonly titleRef: (element: HTMLButtonElement | null) => void;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onMove: (to: CellAddress) => void;
  readonly onOpen: (itemId: string) => void;
}

export function MatrixCard(props: MatrixCardProps): ReactNode {
  const {
    item,
    current,
    cells,
    fields,
    dragging,
    titleRef,
    onDragStart,
    onDragEnd,
    onMove,
    onOpen,
  } = props;
  const itemActions = useItemContextActions(onOpen);
  const openProps = useItemOpenProps(onOpen);
  const title = item.title.length > 0 ? item.title : 'Untitled';

  return (
    <ContextMenu label={`${title} actions`} items={() => itemActions(item.id, item.title)}>
      {(contextTarget) => (
        <li {...contextTarget} className="min-w-0">
          <Blueprint
            className={cn('flex flex-col gap-1.5 bg-background p-3', dragging ? 'opacity-45' : '')}
          >
            <div
              draggable
              onDragStart={(event) => {
                onDragStart();
                event.dataTransfer.effectAllowed = 'move';
                // Without data attached, Firefox refuses to start the drag at all.
                event.dataTransfer.setData('text/plain', item.id);
              }}
              onDragEnd={onDragEnd}
            >
              <button
                ref={titleRef}
                type="button"
                {...openProps(item.id)}
                className={cn(
                  'min-w-0 w-full text-left any-pointer-coarse:min-h-(--control-lg)',
                  focusRing,
                )}
              >
                <Text variant="h5" as="span" lines={2}>
                  {title}
                </Text>
              </button>
            </div>

            {fields.map((field) => {
              const text = readPropertyText(item, field.key);
              return text.length === 0 ? null : (
                // Line breaks kept and three lines at most, so a long text cannot stretch the card.
                <Text
                  key={field.key}
                  as="span"
                  variant="caption"
                  tone="muted"
                  lines={3}
                  className="whitespace-pre-line"
                >
                  {`${field.label}: ${text}`}
                </Text>
              );
            })}

            {/* A menu of cells rather than a select: a select commits on a single arrow press and
                drops focus when the card leaves its cell, while a menu commits only on a choice. */}
            <Menu
              label={`Move ${title} to`}
              items={cells.map((cell) => ({
                key: cellValue(cell.address),
                label: cell.label,
                disabled: cellValue(cell.address) === cellValue(current),
                onSelect: () => {
                  onMove(cell.address);
                },
              }))}
            >
              {(trigger) => (
                <Button
                  {...trigger}
                  variant="ghost"
                  aria-label={`Move ${title} to`}
                  className="self-start"
                >
                  Move to…
                </Button>
              )}
            </Menu>
          </Blueprint>
        </li>
      )}
    </ContextMenu>
  );
}
