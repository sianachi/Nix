import { Icon } from '@nix/ui';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Code,
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
}

export interface ToolbarProps {
  readonly editor: Editor;

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

export function EditorToolbar({ editor, onUndo, onRedo }: ToolbarProps): ReactNode {
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

        // A prompt rather than a popover, for now. It is the honest placeholder: a link needs a
        // destination typed somewhere, and a half-built inline editor that loses what you typed is
        // worse than the browser's own box.
        const href = globalThis.prompt('Link to');
        if (href !== null && href.trim().length > 0) {
          editor.chain().focus().setLink({ href: href.trim() }).run();
        }
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
      run: () => {
        const src = globalThis.prompt('Image address');
        if (src !== null && src.trim().length > 0) {
          editor.chain().focus().setImage({ src: src.trim() }).run();
        }
      },
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
    { id: 'undo', label: 'Undo', icon: Undo2, run: onUndo },
    { id: 'redo', label: 'Redo', icon: Redo2, run: onRedo },
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
      title={control.label}
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
