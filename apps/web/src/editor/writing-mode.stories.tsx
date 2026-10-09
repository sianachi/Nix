import { nixEditingExtensions } from '@nix/editor-schema';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, type ReactElement } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT } from '../layout/regions';
import { ColumnWidthControls } from './column-width';
import { MoveBlock } from './move-block';
import { proseRoot } from './prose';
import { readingExtensions } from './reading-extensions';
import { TableControls } from './table-controls';
import { EditorToolbar } from './toolbar';
import {
  setEditorWritingMode,
  useWritingModePreference,
  WritingModeKeymap,
  WRITING_MODES,
  type WritingMode,
} from './writing-mode';
import { WritingModeControl } from './writing-mode-control';

export default { title: 'Nix/Editor/Writing modes', parameters: { layout: 'padded' } };

function Writing({
  initialMode = 'prose',
  compact = false,
  content = '<p>At the edge of morning<br>the quiet holds its breath.</p><p>A new day begins.</p>',
}: {
  readonly initialMode?: WritingMode;
  readonly compact?: boolean;
  readonly content?: string;
}): ReactElement {
  const mode = useWritingModePreference((state) => state.mode);
  useEffect(() => {
    useWritingModePreference.setState({ mode: initialMode, saved: true });
  }, [initialMode]);
  const editor = useEditor({
    extensions: [
      ...readingExtensions,
      ...nixEditingExtensions.filter(
        (extension) => !readingExtensions.some((reading) => reading.name === extension.name),
      ),
      WritingModeKeymap,
      MoveBlock,
      TableControls,
      ColumnWidthControls,
    ],
    content,
    editorProps: {
      attributes: {
        class: `${proseRoot} min-h-48 outline-none`,
        'data-writing-mode': mode,
        role: 'textbox',
        'aria-label': 'Note body',
        'aria-multiline': 'true',
      },
    },
  });
  useEffect(() => {
    setEditorWritingMode(editor, mode);
  }, [editor, mode]);

  return (
    <div className={compact ? 'w-80 max-w-full space-y-4' : 'w-full space-y-4'}>
      <div className="max-w-full overflow-x-auto">
        <EditorToolbar
          editor={editor}
          compact={compact}
          writingMode={mode}
          writingModeControl={<WritingModeControl />}
          onInsertImage={() => undefined}
          onInsertLink={() => undefined}
          onUndo={() => undefined}
          onRedo={() => undefined}
        />
      </div>
      <div className={`w-full ${WRITING_MODES[mode].measure}`}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

export const Prose = { render: (): ReactElement => <Writing /> };
export const Poetry = { render: (): ReactElement => <Writing initialMode="poetry" /> };
export const PhonePoetry = {
  render: (): ReactElement => <Writing initialMode="poetry" compact />,
};
export const Planning = { render: (): ReactElement => <Writing initialMode="planning" /> };
export const Collaboration = {
  render: (): ReactElement => <Writing initialMode="collaboration" />,
};
export const PhonePlanning = {
  render: (): ReactElement => <Writing initialMode="planning" compact />,
};
export const ModeChoices = {
  render: (): ReactElement => <Writing />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Writing mode: Prose' }),
    );
  },
};

export const TouchTypography = {
  render: (): ReactElement => (
    <Writing
      initialMode="planning"
      content="<p>Body text stays readable.</p><pre><code>Code stays readable.</code></pre><table><tbody><tr><td><p>Table text stays readable.</p></td></tr></tbody></table>"
    />
  ),
  play: ({ canvasElement }: { canvasElement: HTMLElement }): void => {
    const canvas = within(canvasElement);
    const view = canvasElement.ownerDocument.defaultView;
    if (view === null) throw new Error('The writing story needs a browser window.');
    const touch =
      view.matchMedia('(any-pointer: coarse)').matches ||
      !view.matchMedia(WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT).matches;
    const body = canvas.getByRole('textbox', { name: 'Note body' });
    const code = body.querySelector('pre');
    if (code === null) throw new Error('The writing story needs its code sample.');
    for (const element of [body, code, canvas.getByRole('table')]) {
      const size = Number.parseFloat(view.getComputedStyle(element).fontSize);
      if (!Number.isFinite(size) || (touch ? size < 16 : size >= 16)) {
        throw new Error(
          `Unexpected ${touch ? 'touch' : 'desktop'} writing size: ${String(size)}px.`,
        );
      }
    }
  },
};
