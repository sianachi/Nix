import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import type { ReactElement } from 'react';
import { readingExtensions } from './reading-extensions';
import { proseRoot } from './prose';
import { EditorToolbar } from './toolbar';
import { MoveBlock } from './move-block';
import { TableControls } from './table-controls';
import { ColumnWidthControls } from './column-width';

export default { title: 'Nix/Editor/Text alignment', parameters: { layout: 'padded' } };

const POEM =
  '<p>At the edge of morning<br>the quiet holds its breath.</p>' +
  '<p style="text-align: center">A window fills with light<br>and lets the day begin.</p>' +
  '<p style="text-align: right">The last star<br>takes its time.</p>';

function Poem({
  compact = false,
  readOnly = false,
}: {
  compact?: boolean;
  readOnly?: boolean;
}): ReactElement {
  const editor = useEditor({
    extensions: [
      ...readingExtensions,
      ...nixEditingExtensions.filter(
        (extension) => !readingExtensions.some((reading) => reading.name === extension.name),
      ),
      MoveBlock,
      TableControls,
      ColumnWidthControls,
    ],
    content: POEM,
    editable: !readOnly,
    editorProps: { attributes: { class: proseRoot, role: 'textbox', 'aria-label': 'Poem' } },
  });
  return (
    <div className="space-y-4">
      {readOnly ? null : (
        <EditorToolbar
          editor={editor}
          compact={compact}
          onInsertImage={() => undefined}
          onInsertLink={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

export const WritingPoem = { render: (): ReactElement => <Poem /> };
export const MobileWritingTools = { render: (): ReactElement => <Poem compact /> };
export const ReadingPoem = { render: (): ReactElement => <Poem readOnly /> };
