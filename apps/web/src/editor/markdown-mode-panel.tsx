import { Button, Dialog, Text, Textarea } from '@nix/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';

import { announce } from '../a11y/announcer';
import {
  applyMarkdown,
  snapshotMarkdown,
  watchRemoteChanges,
  type MarkdownSnapshot,
} from './markdown-mode';

export interface MarkdownModePanelProps {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  /** Taken when the person asked for the mode, so the dialog and the textarea agree on the text. */
  readonly snapshot: MarkdownSnapshot;
  readonly onClose: () => void;
}

/**
 * The textarea a note is edited as Markdown in, with the two honesty devices the mode needs: a
 * banner when a colleague changes the note underneath, and a report when the text cannot be read
 * back. Nothing is written until Apply; closing discards the text, and the banner says so.
 *
 * shortcut: a plain textarea with no highlighting; upgrade to a code editor if people ask.
 */
export function MarkdownModePanel({ doc, fragment, snapshot, onClose }: MarkdownModePanelProps): ReactNode {
  const [text, setText] = useState(snapshot.markdown);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  useEffect(
    () =>
      watchRemoteChanges(fragment, () => {
        setRemoteChanged(true);
      }),
    [fragment],
  );

  function apply(): void {
    const outcome = applyMarkdown(doc, fragment, text, snapshot.markdown);
    if (outcome.kind === 'invalid') {
      setError(outcome.reason);
      return;
    }
    announce(outcome.kind === 'applied' ? 'Markdown applied to the note.' : 'No changes to apply.');
    onClose();
  }

  return (
    <section aria-label="Markdown editing" className="flex min-h-0 flex-1 flex-col gap-3">
      {remoteChanged ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-divider bg-surface px-3 py-2"
        >
          <Text variant="note">
            Someone changed this note while you were editing its Markdown. Applying will replace
            their change with your text.
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              setText(snapshotMarkdown(fragment).markdown);
              setRemoteChanged(false);
            }}
          >
            Reload their text
          </Button>
        </div>
      ) : null}
      <Text as="p" id={hintId} variant="caption" tone="muted">
        Nothing is saved until you apply. Closing without applying discards this text.
      </Text>
      <Textarea
        aria-label="Note as Markdown"
        aria-describedby={hintId}
        value={text}
        spellCheck={false}
        rows={24}
        resize="vertical"
        className="min-h-0 flex-1 font-mono text-sm"
        onChange={(event) => {
          setText(event.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          // Tab indents inside the text, the way a Markdown editor is expected to behave.
          if (event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            const target = event.currentTarget;
            const { selectionStart, selectionEnd } = target;
            const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
            setText(next);
            requestAnimationFrame(() => {
              target.setSelectionRange(selectionStart + 2, selectionStart + 2);
            });
          }
        }}
      />
      {error === null ? null : (
        <Text as="p" variant="note" role="alert">
          {error}
        </Text>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            if (remoteChanged && text !== snapshot.markdown) setConfirmOverwrite(true);
            else apply();
          }}
        >
          Apply Markdown
        </Button>
      </div>
      {confirmOverwrite ? (
        <Dialog
          open
          title="Replace their change?"
          onClose={() => {
            setConfirmOverwrite(false);
          }}
          actions={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmOverwrite(false);
                }}
              >
                Keep editing
              </Button>
              <Button
                onClick={() => {
                  setConfirmOverwrite(false);
                  apply();
                }}
              >
                Replace and apply
              </Button>
            </>
          }
        >
          <Text as="p">
            Your Markdown will replace the note as it is now, including what someone else changed
            while you were editing. They can undo their own edits; you can undo this one.
          </Text>
        </Dialog>
      ) : null}
    </section>
  );
}

/** The dialog shown before entering when Markdown cannot carry everything in the note. */
export function MarkdownLossesDialog({
  snapshot,
  onContinue,
  onCancel,
}: {
  readonly snapshot: MarkdownSnapshot;
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <Dialog
      open
      title="Some formatting will not survive"
      onClose={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onContinue}>Continue anyway</Button>
        </>
      }
    >
      <Text as="p">
        Markdown cannot carry everything in this note. If you apply the Markdown afterwards, the
        following is dropped or simplified. Cancel keeps the note exactly as it is.
      </Text>
      <ul className="list-disc pl-5">
        {snapshot.losses.map((loss) => (
          <li key={loss.kind}>
            <Text as="span" variant="bodySmall">
              {loss.detail}
            </Text>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
