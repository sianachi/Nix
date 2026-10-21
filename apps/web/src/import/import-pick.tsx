import { Button, Text } from '@nix/ui';
import { useRef, type ReactNode } from 'react';

/** Some browsers have no folder picker; offering the button there would silently pick files. */
const FOLDER_PICK_SUPPORTED =
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

export function PickStep({
  reading,
  error,
  onChose,
}: {
  readonly reading: boolean;
  readonly error: string | null;
  readonly onChose: (files: readonly File[]) => void;
}): ReactNode {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <Text tone="muted" variant="body">
        Choose a PDF, Word document, UTF-8 text file, Nix archive, Markdown files, an Obsidian
        vault, or folders containing Markdown notes and attachments. Documents become editable notes
        and their original files are retained as children. Markdown folders keep their hierarchy,
        supported formatting, and non-hidden attachments.
      </Text>
      <Text tone="muted" variant="note">
        PDF import extracts existing text but does not perform OCR. The preview names content that
        cannot be preserved before anything is created.
      </Text>
      <div className="flex flex-wrap gap-2">
        {/* Out of the tab order and the a11y tree: the visible buttons are the controls, and
                  a focusable but invisible input is a focus ring nobody can see. */}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Markdown files to import"
          onChange={(event) => {
            // Snapshot before resetting: browsers can clear the existing FileList in place.
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            onChose(files);
          }}
        />
        <input
          ref={folderInput}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Folder to import"
          {...{ webkitdirectory: '' }}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            onChose(files);
          }}
        />
        {FOLDER_PICK_SUPPORTED ? (
          <Button
            disabled={reading}
            onClick={() => {
              folderInput.current?.click();
            }}
          >
            Choose a vault or folder
          </Button>
        ) : null}
        <Button
          variant="secondary"
          disabled={reading}
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          Choose files
        </Button>
      </div>
      {FOLDER_PICK_SUPPORTED ? null : (
        <Text tone="muted" variant="note">
          This browser cannot select folders. You can still choose Markdown files.
        </Text>
      )}
      {reading ? <Text tone="muted">Reading the files…</Text> : null}
      {error !== null ? (
        <div role="alert">
          <Text tone="muted">{error}</Text>
        </div>
      ) : null}
    </>
  );
}
