import { Icon } from '@nix/ui';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Code,
  Columns2,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Rows3,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The formatting toolbar.
 *
 * **Every control here is a shortcut somebody does not know yet.** The keyboard is the primary
 * interface for all of it - the marks have the shortcuts everybody already has in their fingers,
 * and the blocks have input rules, so `# ` makes a heading and `- ` makes a list. The toolbar
 * exists so none of that has to be discovered before the editor is usable.
 *
 * Grouped by what a control does to the document rather than by how often it is used: turn this
 * block into another kind, make this run of text look different, put something new here. A flat
 * row of twenty buttons is a row nobody reads.
 *
 * **The table group appears only inside a table.** Row and column operations are meaningless
 * anywhere else, and a permanent row of controls that do nothing most of the time teaches people
 * to stop looking at the toolbar.
 */

interface Control {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly run: () => void;
  /** Whether the control describes the selection right now. Omitted for inserts, which have no state. */
  readonly active?: boolean;
  /** Whether the command can run at all here. */
  readonly enabled?: boolean;
  /** The keys that do the same thing, shown in the tooltip. A control nobody can find is a control nobody uses. */
  readonly shortcut?: string;
  /** The platform-resolved form of `shortcut`, for assistive technology. */
  readonly ariaShortcut?: string;
}

// ProseMirror resolves `Mod` from this exact platform signal. Keeping the display tied to the same
// test prevents the toolbar from advertising Command while the keymap is listening for Control.
const navigatorPlatform: unknown =
  typeof navigator === 'undefined' ? undefined : Reflect.get(navigator, 'platform');
const applePlatform =
  typeof navigatorPlatform === 'string' && /Mac|iP(hone|[oa]d)/.test(navigatorPlatform);
const ariaModifier = applePlatform ? 'Meta' : 'Control';
const visibleModifier = applePlatform ? 'Command' : 'Ctrl';

export interface ToolbarProps {
  readonly editor: Editor;

  /** Opens the editor-owned image form without making this toolbar own modal state. */
  readonly onInsertImage: () => void;

  /** Opens the editor-owned link form for the current selection. */
  readonly onInsertLink: () => void;

  /**
   * The document's own history.
   *
   * Passed in rather than reached for, because this is a CRDT and its undo is not the editor's:
   * ProseMirror's default history would revert whichever edit came last, including a colleague's.
   * Keeping that knowledge outside the toolbar is what stops the wrong one being wired here later.
   */
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

export function EditorToolbar({
  editor,
  onInsertImage,
  onInsertLink,
  onUndo,
  onRedo,
}: ToolbarProps): ReactNode {
  // **A destroyed editor is a normal thing to be handed, and it used to crash the page.**
  // `useEditor` tears the old editor down and builds a new one whenever its dependencies change,
  // and React's strict mode does that on every mount in development. `destroy()` sets the
  // editor's command manager to null, so a render that lands between the teardown and the
  // replacement reached `editor.can()` on an editor that no longer has one - which threw out of
  // render and took the whole root down with it, repeatedly.
  //
  // Nothing is drawn rather than a row of disabled buttons: this state lasts a frame, and a
  // toolbar that flickers into a disabled version of itself is worse to look at than one that
  // appears a frame later.
  if (editor.isDestroyed) {
    return null;
  }

  const inTable = editor.isActive('table');
  const inColumns = editor.isActive('columnBlock');

  const blocks: readonly Control[] = [
    {
      id: 'paragraph',
      label: 'Text',
      icon: Pilcrow,
      active: editor.isActive('paragraph'),
      run: () => void editor.chain().focus().setParagraph().run(),
    },
    {
      id: 'heading-1',
      label: 'Heading 1',
      icon: Heading1,
      active: editor.isActive('heading', { level: 1 }),
      run: () => void editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      id: 'heading-2',
      label: 'Heading 2',
      icon: Heading2,
      active: editor.isActive('heading', { level: 2 }),
      run: () => void editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: 'heading-3',
      label: 'Heading 3',
      icon: Heading3,
      active: editor.isActive('heading', { level: 3 }),
      run: () => void editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
  ];

  const lists: readonly Control[] = [
    {
      id: 'bulletList',
      label: 'Bulleted list',
      icon: List,
      active: editor.isActive('bulletList'),
      run: () => void editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: 'orderedList',
      label: 'Numbered list',
      icon: ListOrdered,
      active: editor.isActive('orderedList'),
      run: () => void editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: 'taskList',
      label: 'Task list',
      icon: ListChecks,
      active: editor.isActive('taskList'),
      run: () => void editor.chain().focus().toggleTaskList().run(),
    },
    {
      id: 'blockquote',
      label: 'Quote',
      icon: Quote,
      active: editor.isActive('blockquote'),
      run: () => void editor.chain().focus().toggleBlockquote().run(),
    },
    {
      id: 'codeBlock',
      label: 'Code block',
      icon: SquareCode,
      active: editor.isActive('codeBlock'),
      run: () => void editor.chain().focus().toggleCodeBlock().run(),
    },
  ];

  const marks: readonly Control[] = [
    {
      id: 'bold',
      label: 'Bold',
      icon: Bold,
      active: editor.isActive('bold'),
      run: () => void editor.chain().focus().toggleBold().run(),
    },
    {
      id: 'italic',
      label: 'Italic',
      icon: Italic,
      active: editor.isActive('italic'),
      run: () => void editor.chain().focus().toggleItalic().run(),
    },
    {
      id: 'underline',
      label: 'Underline',
      icon: Underline,
      active: editor.isActive('underline'),
      run: () => void editor.chain().focus().toggleUnderline().run(),
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      icon: Strikethrough,
      active: editor.isActive('strike'),
      run: () => void editor.chain().focus().toggleStrike().run(),
    },
    {
      id: 'code',
      label: 'Inline code',
      icon: Code,
      active: editor.isActive('code'),
      run: () => void editor.chain().focus().toggleCode().run(),
    },
    {
      id: 'highlight',
      label: 'Highlight',
      icon: Highlighter,
      active: editor.isActive('highlight'),
      run: () => void editor.chain().focus().toggleHighlight().run(),
    },
    {
      id: 'link',
      label: editor.isActive('link') ? 'Remove link' : 'Add link',
      icon: LinkIcon,
      active: editor.isActive('link'),
      run: () => {
        if (editor.isActive('link')) {
          editor.chain().focus().unsetLink().run();
          return;
        }

        onInsertLink();
      },
    },
  ];

  const inserts: readonly Control[] = [
    {
      id: 'horizontalRule',
      label: 'Divider',
      icon: Minus,
      run: () => void editor.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'image',
      label: 'Image',
      icon: ImageIcon,
      run: onInsertImage,
    },
    {
      id: 'table',
      label: 'Insert table',
      icon: TableIcon,
      run: () =>
        void editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
  ];

  const history: readonly Control[] = [
    {
      id: 'undo',
      label: 'Undo',
      icon: Undo2,
      shortcut: `${visibleModifier}+Z`,
      ariaShortcut: `${ariaModifier}+Z`,
      run: onUndo,
    },
    {
      id: 'redo',
      label: 'Redo',
      icon: Redo2,
      shortcut: `${visibleModifier}+Shift+Z or ${visibleModifier}+Y`,
      ariaShortcut: `${ariaModifier}+Shift+Z ${ariaModifier}+Y`,
      run: onRedo,
    },
  ];

  /**
   * What a person can do to a row of columns once it exists.
   *
   * **Without this group the row is a trap.** The slash menu inserts two columns and the handles
   * resize them; nothing else in the interface could add a third, take one away, or get back to
   * ordinary flow - the only exit was deleting content until the normaliser unwrapped the row.
   * The keyboard shortcuts are the same commands, and they are in the tooltips because a
   * shortcut nobody is told about is not a shortcut.
   *
   * Shown at every width, unlike the resize handles: below the medium breakpoint the row stacks
   * and there is nothing to drag, so this is the only way a narrow screen has to operate it.
   */
  const columns: readonly Control[] = [
    {
      id: 'addColumnToRow',
      label: 'Add column',
      icon: Columns3,
      shortcut: 'Mod+Alt+Enter',
      run: () => void editor.chain().focus().addColumnToRow().run(),
      enabled: editor.can().addColumnToRow(),
    },
    {
      id: 'removeColumnFromRow',
      label: 'Remove column',
      icon: Columns2,
      shortcut: 'Mod+Alt+Backspace',
      // Removing the last column unwraps the row back into ordinary flow, which is also how
      // somebody leaves columns behind: it is the exit, not just a deletion.
      run: () => void editor.chain().focus().removeColumnFromRow().run(),
      enabled: editor.can().removeColumnFromRow(),
    },
  ];

  const table: readonly Control[] = [
    {
      id: 'addColumn',
      label: 'Add column',
      icon: Columns3,
      run: () => void editor.chain().focus().addColumnAfter().run(),
      enabled: editor.can().addColumnAfter(),
    },
    {
      id: 'addRow',
      label: 'Add row',
      icon: Rows3,
      run: () => void editor.chain().focus().addRowAfter().run(),
      enabled: editor.can().addRowAfter(),
    },
    {
      id: 'deleteColumn',
      label: 'Delete column',
      icon: Columns3,
      run: () => void editor.chain().focus().deleteColumn().run(),
      enabled: editor.can().deleteColumn(),
    },
    {
      id: 'deleteRow',
      label: 'Delete row',
      icon: Rows3,
      run: () => void editor.chain().focus().deleteRow().run(),
      enabled: editor.can().deleteRow(),
    },
    {
      id: 'deleteTable',
      label: 'Delete table',
      icon: Trash2,
      run: () => void editor.chain().focus().deleteTable().run(),
      enabled: editor.can().deleteTable(),
    },
  ];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      className="flex flex-wrap items-center gap-0.5 px-8 py-1.5"
    >
      <Group controls={blocks} />
      <Separator />
      <Group controls={lists} />
      <Separator />
      <Group controls={marks} />
      <Separator />
      <Group controls={inserts} />
      <Separator />
      <Group controls={history} label="History" />

      {inColumns ? (
        <>
          <Separator />
          <Group controls={columns} label="Columns" />
        </>
      ) : null}

      {inTable ? (
        <>
          <Separator />
          <Group controls={table} label="Table" />
        </>
      ) : null}
    </div>
  );
}

function Group({
  controls,
  label,
}: {
  readonly controls: readonly Control[];
  readonly label?: string;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {controls.map((control) => (
        <ToolbarButton key={control.id} control={control} />
      ))}
    </div>
  );
}

function ToolbarButton({ control }: { readonly control: Control }): ReactNode {
  const disabled = control.enabled === false;

  return (
    <button
      type="button"
      aria-label={control.label}
      aria-keyshortcuts={control.ariaShortcut}
      title={
        control.shortcut === undefined ? control.label : `${control.label} (${control.shortcut})`
      }
      // Only where the control has an on and an off. An insert is an action, not a state, and
      // aria-pressed="false" on one would tell a screen reader it is a toggle that is currently
      // off - which is a different and untrue thing.
      aria-pressed={control.active}
      disabled={disabled}
      onClick={control.run}
      className={[
        'flex size-7 items-center justify-center rounded-sm',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        disabled
          ? 'cursor-not-allowed text-muted opacity-40'
          : control.active === true
            ? 'bg-accent/18 text-foreground'
            : 'text-muted hover:bg-foreground/7 hover:text-foreground',
      ].join(' ')}
    >
      <Icon icon={control.icon} size="sm" />
    </button>
  );
}

function Separator(): ReactNode {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-divider" />;
}
