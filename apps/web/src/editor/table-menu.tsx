import { Icon, Text } from '@nix/ui';
import type { Editor } from '@tiptap/react';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Columns3,
  PanelLeft,
  PanelTop,
  Rows3,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cellCoordinates, hasHeaderColumn, hasHeaderRow, tableContext } from './table-controls';

/**
 * The table menu: every operation on a table, floating over the table it operates on.
 *
 * **Why it floats.** The main toolbar used to be the only place with row and column commands,
 * five of them, in a group that appeared at the far end of the toolbar when the caret entered a
 * table and vanished when it left. That is the wrong place for them twice over: the caret is in
 * the table, the eye is on the table, and the toolbar is at the top of the pane - on a long
 * note, off the screen. So this sits just above the table's own top edge, in the same shape as
 * the selection bubble menu (`bubble-menu.tsx`) and for the same reasons: placed in viewport
 * coordinates, re-read on every transaction and on scroll, one tab stop with the arrows walking
 * the row, Escape back to the text. The toolbar group stays for the narrow layout, where a
 * floating row of eleven controls would cover the table it belongs to.
 *
 * **Where you are is written down.** "Row 2, column 3" at the left of the menu, because each
 * of these commands acts on the current row or column and the decorations that tint them
 * (`table-controls.ts`) are a picture; a screen-reader user gets the words.
 *
 * **Disabled means focusable.** A control that cannot run here stays in the tab order and says
 * so with `aria-disabled`, which is what a toolbar's roving focus expects: a button that drops
 * out of the row when it is disabled is a row whose length changes under the arrow keys.
 */

interface TableControl {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly run: () => void;
  readonly enabled: boolean;
  /** Only for the two header toggles, which have an on and an off. */
  readonly active?: boolean;
}

interface ControlGroup {
  readonly label: string;
  readonly controls: readonly TableControl[];
}

/** The menu's own height plus the gap it keeps from the table; below this it flips inside. */
const MENU_CLEARANCE = 48;
const MENU_GAP = 6;

interface Placement {
  readonly left: number;
  readonly top: number;
  /** Pinned to the top of the viewport, because the table's top edge has scrolled off it. */
  readonly pinned: boolean;
}

/** What the menu offers here, grouped the way the row is read. */
export function tableControlGroups(editor: Editor): readonly ControlGroup[] {
  const can = editor.can();
  const context = tableContext(editor.state);
  const table = context?.table ?? null;

  const rows: TableControl[] = [
    {
      id: 'addRowBefore',
      label: 'Insert row above',
      icon: BetweenHorizontalStart,
      run: () => void editor.chain().focus().addRowBefore().run(),
      enabled: can.addRowBefore(),
    },
    {
      id: 'addRowAfter',
      label: 'Insert row below',
      icon: BetweenHorizontalEnd,
      run: () => void editor.chain().focus().addRowAfter().run(),
      enabled: can.addRowAfter(),
    },
    {
      id: 'deleteRow',
      label: 'Delete row',
      icon: Rows3,
      run: () => void editor.chain().focus().deleteRow().run(),
      enabled: can.deleteRow(),
    },
  ];

  const columns: TableControl[] = [
    {
      id: 'addColumnBefore',
      label: 'Insert column left',
      icon: BetweenVerticalStart,
      run: () => void editor.chain().focus().addColumnBefore().run(),
      enabled: can.addColumnBefore(),
    },
    {
      id: 'addColumnAfter',
      label: 'Insert column right',
      icon: BetweenVerticalEnd,
      run: () => void editor.chain().focus().addColumnAfter().run(),
      enabled: can.addColumnAfter(),
    },
    {
      id: 'deleteColumn',
      label: 'Delete column',
      icon: Columns3,
      run: () => void editor.chain().focus().deleteColumn().run(),
      enabled: can.deleteColumn(),
    },
  ];

  const cells: TableControl[] = [
    {
      id: 'mergeCells',
      label: 'Merge cells',
      icon: TableCellsMerge,
      run: () => void editor.chain().focus().mergeCells().run(),
      enabled: can.mergeCells(),
    },
    {
      id: 'splitCell',
      label: 'Split cell',
      icon: TableCellsSplit,
      run: () => void editor.chain().focus().splitCell().run(),
      enabled: can.splitCell(),
    },
  ];

  const headers: TableControl[] = [
    {
      id: 'toggleHeaderRow',
      label: 'Header row',
      icon: PanelTop,
      run: () => void editor.chain().focus().toggleHeaderRow().run(),
      enabled: can.toggleHeaderRow(),
      active: table !== null && hasHeaderRow(table),
    },
    {
      id: 'toggleHeaderColumn',
      label: 'Header column',
      icon: PanelLeft,
      run: () => void editor.chain().focus().toggleHeaderColumn().run(),
      enabled: can.toggleHeaderColumn(),
      active: table !== null && hasHeaderColumn(table),
    },
  ];

  const whole: TableControl[] = [
    {
      id: 'deleteTable',
      label: 'Delete table',
      icon: Trash2,
      run: () => void editor.chain().focus().deleteTable().run(),
      enabled: can.deleteTable(),
    },
  ];

  return [
    { label: 'Rows', controls: rows },
    { label: 'Columns', controls: columns },
    { label: 'Cells', controls: cells },
    { label: 'Headers', controls: headers },
    { label: 'Table', controls: whole },
  ];
}

export function TableMenu({ editor }: { readonly editor: Editor }): ReactNode {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frame: number | null = null;

    function read(): void {
      if (editor.isDestroyed) {
        setPlacement(null);
        return;
      }
      const context = tableContext(editor.state);
      if (context === null) {
        setPlacement(null);
        return;
      }
      const dom = editor.view.nodeDOM(context.pos);
      if (!(dom instanceof HTMLElement)) {
        setPlacement(null);
        return;
      }
      const rect = dom.getBoundingClientRect();
      // Scrolled entirely off the viewport: nothing to float over.
      if (rect.bottom < MENU_CLEARANCE || rect.top > window.innerHeight) {
        setPlacement(null);
        return;
      }
      const pinned = rect.top - MENU_GAP < MENU_CLEARANCE;
      setPlacement({
        left: rect.left,
        top: pinned ? MENU_GAP : rect.top - MENU_GAP,
        pinned,
      });
    }

    function schedule(): void {
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        read();
      });
    }

    // Focus moving into the menu is a keyboard user arriving, not focus leaving the table.
    function onBlur({ event }: { readonly event: FocusEvent }): void {
      const destination = event.relatedTarget;
      if (destination instanceof Node && container.current?.contains(destination) === true) {
        return;
      }
      setPlacement(null);
    }

    read();
    editor.on('transaction', read);
    editor.on('blur', onBlur);
    editor.on('focus', read);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      editor.off('transaction', read);
      editor.off('blur', onBlur);
      editor.off('focus', read);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [editor]);

  if (editor.isDestroyed || placement === null) {
    return null;
  }

  const context = tableContext(editor.state);
  if (context === null) {
    return null;
  }

  const groups = tableControlGroups(editor);
  const row = groups.flatMap((group) => group.controls);
  const coordinates = cellCoordinates(context);
  const tabStop = focusIndex < row.length ? focusIndex : 0;

  function rove(from: number, step: number): void {
    const next = (((from + step) % row.length) + row.length) % row.length;
    setFocusIndex(next);
    buttons.current[next]?.focus();
  }

  return (
    <div
      ref={container}
      role="toolbar"
      aria-label="Table tools"
      aria-orientation="horizontal"
      style={{ left: placement.left, top: placement.top }} // design-token-exempt: the table's position is a runtime measurement, not a scale step.
      className={[
        'fixed z-20 flex max-w-full flex-wrap items-center gap-2 rounded-md border border-divider bg-surface p-1 shadow-md',
        placement.pinned ? '' : '-translate-y-full',
      ].join(' ')}
      // Swallowed before the browser can move focus: a press on a menu button must not blur
      // the editor, or a cell selection about to be merged would collapse under the click.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          editor.commands.focus();
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          rove(tabStop, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          rove(tabStop, -1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          rove(0, 0);
        } else if (event.key === 'End') {
          event.preventDefault();
          rove(row.length - 1, 0);
        }
      }}
    >
      {coordinates !== null ? (
        <Text variant="caption" tone="muted" as="span" className="px-1.5 whitespace-nowrap">
          Row {String(coordinates.row)}, column {String(coordinates.column)}
        </Text>
      ) : null}
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label} className="flex gap-0.5">
          {group.controls.map((control) => {
            const index = row.indexOf(control);
            return (
              <button
                key={control.id}
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                type="button"
                aria-label={control.label}
                title={control.label}
                aria-pressed={control.active}
                aria-disabled={control.enabled ? undefined : true}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={() => {
                  if (control.enabled) {
                    control.run();
                  }
                }}
                className={[
                  'flex size-7 items-center justify-center rounded-sm',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                  !control.enabled
                    ? 'cursor-not-allowed text-muted opacity-40'
                    : control.active === true
                      ? 'bg-accent/18 text-foreground'
                      : 'text-muted hover:bg-foreground/7 hover:text-foreground',
                ].join(' ')}
              >
                <Icon icon={control.icon} size="sm" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
