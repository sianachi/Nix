import { Button, Text } from '@nix/ui';
import { useId, useRef, type ReactNode } from 'react';

import { FocusOnMount } from './import-focus-on-mount';

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

  const errorId = useId();
  const describedBy = error === null ? undefined : errorId;

  return (
    <>
      <Text tone="muted" variant="body">
        Choose a PDF, Word, text or Nix archive file, Markdown files, or a folder or Obsidian vault.
      </Text>
      <Text tone="muted" variant="note">
        PDFs are read as text only, without OCR. The preview lists anything that cannot be kept
        before anything is created.
      </Text>
      {/* Out of the tab order and the a11y tree: the visible buttons are the controls, and a
          focusable but invisible input is a focus ring nobody can see. */}
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
      {/* Stacked and full width on a phone, where a thumb needs the whole row. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          disabled={reading}
          aria-describedby={describedBy}
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          Choose files
        </Button>
        {FOLDER_PICK_SUPPORTED ? (
          <Button
            variant="secondary"
            disabled={reading}
            aria-describedby={describedBy}
            onClick={() => {
              folderInput.current?.click();
            }}
          >
            Choose a vault or folder
          </Button>
        ) : null}
      </div>
      {FOLDER_PICK_SUPPORTED ? null : (
        <Text tone="muted" variant="note">
          Folders cannot be chosen in this browser.
        </Text>
      )}
      {reading ? <Text tone="muted">Reading the files…</Text> : null}
      {error !== null ? (
        // Focus moves here when it appears, so the reason is read where the failed pick left off.
        <FocusOnMount key={error}>
          <div role="alert" id={errorId}>
            <Text tone="accent">{error}</Text>
          </div>
        </FocusOnMount>
      ) : null}
    </>
  );
}
