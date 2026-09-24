import { files as fileResources, type NixClient } from '@nix/api-client';
import {
  Button,
  Duotone,
  Field,
  Input,
  Text,
  blueprintFrame,
  cn,
  disabledState,
  focusRing,
} from '@nix/ui';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useOptionalApiClient } from '../api/api-client-provider';
import { isImageFile, mediaTypeForFile } from '../lib/file-kind';
import { isFetchableImageAddress } from '../lib/image-address';
import { readPropertyText } from '../views/core/container-model';
import { useOptionalWorkspace } from '../workspaces/workspace-context';

import type { PropertyInputProps } from './property-input';

/**
 * The picture property's control: a picker, not a text field.
 *
 * **Still an address underneath, by design.** There is no file or media model in this build, so
 * "choose a picture" means "hand over an address a browser may fetch" - typed, pasted, or read off
 * a dragged image or link. What changed from the plain url field is what is *shown*: the thing the
 * address is for. A property whose whole point is a picture, edited as a line of text, made
 * somebody open the gallery to find out whether the line they typed was the picture they meant.
 *
 * **Four states, told apart in words, mirroring the gallery card's ladder** (`CoverPane`): nothing
 * set - an address box and the sentence saying a link can be pasted or dragged in; a value
 * that is not a fetchable address - the box, prefilled, with the reason beside it, never handed to
 * an `img` (a schema retype does not revalidate stored values, so yesterday's text can be today's
 * picture property); set - the thumbnail through `<Duotone>`, the address, an edit affordance and a
 * remove control; failed - the words that say the fetch broke, with the address still shown,
 * because the property is not empty and telling somebody it was would send them re-entering an
 * address that is already right.
 *
 * **The failure is the address that failed, not a flag.** Same reasoning as the gallery: a boolean
 * would need a mirrored copy of the address to know when to clear. Stored as the URL, "failed" is
 * derived - a corrected address simply is not the failed one, so the state self-heals with nothing
 * to reconcile.
 *
 * **Validation mirrors `PropertyValidator.CheckImage` for immediacy; the server stays the
 * authority.** An invalid address is refused in place, with the server's own sentence shape, and
 * nothing is written - a client that wrote it anyway would show the refusal a round-trip later
 * against a field that has already moved on.
 *
 * **Self-contained rather than sharing `property-input.tsx`'s shells.** The shells wire a label to
 * exactly one control; the set state here is three - thumbnail, address, remove - and importing
 * them back would make the two files a cycle. The dependency stays one-way: the dispatch imports
 * this component, and this component imports only the props type, which compiles away.
 */

/**
 * What a dropped *file* is answered with when this control has nowhere to send it.
 *
 * Uploading needs a workspace to attach the file to (see {@link useOptionalWorkspace}), which a
 * control rendered off a public form link does not have. The drag paints the accent outline the
 * moment it hovers - that is `onDragOver`'s job, and it cannot know what the drag carries until the
 * drop - so staying silent would be the control lighting up and then doing nothing at all. The
 * sentence says what does work instead.
 */
const FILE_REFUSAL =
  'Pictures are added by address here. Drag in a link to a picture, or paste one.';

/** What a chosen or dropped file is refused with when it is not one this control can upload. */
const UNSUPPORTED_FILE_REFUSAL = 'Choose a PNG, JPEG, WebP or AVIF image no larger than 10 MiB.';

/**
 * The prefix marking a stored value as a reference to a file uploaded through this control,
 * rather than a web address.
 *
 * There is still no media model as such - a picture property is one string - but that string can
 * now name either kind of thing it is for. The prefix is not itself a valid URL scheme, so it can
 * never collide with an address somebody pasted.
 */
// Core's PropertyValidator.CheckImage accepts exactly this prefix followed by a GUID; a change
// here that it does not also make is refused at write time, with no compile-time signal.
const FILE_IMAGE_PREFIX = 'nix-file:';

/** Whether a stored value points at a file this control uploaded, rather than a web address. */
export function isFileImageReference(value: string): boolean {
  return value.startsWith(FILE_IMAGE_PREFIX) && value.length > FILE_IMAGE_PREFIX.length;
}

/** The uploaded file's item id, for a value {@link isFileImageReference} accepts; null otherwise. */
export function fileImageReferenceItemId(value: string): string | null {
  return isFileImageReference(value) ? value.slice(FILE_IMAGE_PREFIX.length) : null;
}

/** The value to store for a newly uploaded file. */
export function fileImageReference(itemId: string): string {
  return `${FILE_IMAGE_PREFIX}${itemId}`;
}

/**
 * Whether a stored value is something a picture surface can show: a fetchable web address, or an
 * uploaded file's reference. Shared with the gallery's cover, which draws the same four states off
 * the same rule.
 */
export function isDisplayableImageValue(value: string): boolean {
  return isFetchableImageAddress(value) || isFileImageReference(value);
}

/** What an uploaded file's picture resolves to, once its item id is known. */
export type FileImagePreview =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error' };

/**
 * Resolves an uploaded file's item id to a browser-usable address.
 *
 * There is no public URL for a file item - every download goes through a signed, short-lived
 * capability (AGENTS.md: files use capability URLs, never Core bytes) - so this fetches the bytes
 * once through that capability and hands back a local object URL, the same resolution the note
 * editor's own image view does for its `fileItemId` attribute (`editor/note-image-view.tsx`). The
 * object URL is revoked the moment the id it was minted for is no longer wanted, on id change and
 * on unmount.
 */
export function useFileImagePreview(
  client: NixClient | null,
  fileItemId: string | null,
): FileImagePreview {
  const [preview, setPreview] = useState<
    | { readonly itemId: string; readonly status: 'ready'; readonly url: string }
    | { readonly itemId: string; readonly status: 'error' }
    | null
  >(null);

  useEffect(() => {
    // No client to fetch through - the same leaf-render case `useOptionalApiClient` exists for -
    // leaves this loading forever rather than erroring, which is the honest answer for a state
    // this build cannot actually resolve either way.
    if (fileItemId === null || client === null) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fileResources
      .fetchFileContent(client, fileItemId, undefined, true, controller.signal)
      .then(({ blob }) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ itemId: fileItemId, status: 'ready', url: objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview({ itemId: fileItemId, status: 'error' });
      });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [client, fileItemId]);

  if (fileItemId === null) return { status: 'error' };
  if (preview?.itemId !== fileItemId) return { status: 'loading' };
  return preview;
}

/** The sentence `PropertyValidator.CheckImage` refuses with, built the same way. */
function refusalSentence(label: string): string {
  return `${label} must be a link to an image, over http or https.`;
}

/**
 * The address a drop gesture carries, if it carries one.
 *
 * `text/uri-list` first, because it is the type an image or a link is dragged as and its grammar
 * is defined (one URI per line, `#` lines are comments); `text/plain` as the fallback for text
 * selections and address-bar drags that never set the richer type.
 */
function droppedAddress(transfer: DataTransfer): string {
  const line = transfer
    .getData('text/uri-list')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#'));

  return line ?? transfer.getData('text/plain').trim();
}

/** The identifiers the shell below hands its one labelled control. */
interface ImageControlProps {
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

interface ImageShellProps {
  readonly density: 'panel' | 'cell';
  readonly label: string;
  readonly name: string;
  readonly required: boolean;
  readonly error: string | null;
  readonly hint?: string;
  readonly children: (control: ImageControlProps) => ReactElement;
}

/**
 * The label, the error and the wiring between them, at either density - the same division of
 * labour as `property-input.tsx`'s shells: panel labels itself through `<Field>`, cell relies on
 * the column header and names its control after its row.
 */
function ImageShell(props: ImageShellProps): ReactNode {
  const { density, label, name, required, error, hint, children } = props;

  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== null && error.length > 0;

  if (density === 'panel') {
    return (
      <Field
        label={label}
        required={required}
        error={error}
        {...(hint === undefined ? {} : { hint })}
      >
        {children}
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {children({
        'aria-label': name,
        'aria-describedby': invalid || hint !== undefined ? noteId : undefined,
        'aria-invalid': invalid ? true : undefined,
      })}

      {/* The refusal sits in the cell that caused it, exactly as the sibling shells place it. */}
      {invalid ? (
        <Text variant="note" id={noteId} role="alert">
          {error}
        </Text>
      ) : hint === undefined ? null : (
        <Text variant="note" tone="muted" id={noteId}>
          {hint}
        </Text>
      )}
    </div>
  );
}

export function ImageValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;

  const stored = readPropertyText(item, property.key);
  const name =
    density === 'cell' ? `${property.label} for ${item.title || 'Untitled'}` : property.label;

  const [draft, setDraft] = useState(stored);
  const [sent, setSent] = useState(stored);
  const [seen, setSeen] = useState(stored);
  const [editing, setEditing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Both optional, and for related reasons. A control drawn off a public form link genuinely has
  // no workspace to upload into (see `useOptionalWorkspace`); a control under test is very often
  // rendered as a bare leaf, with no provider tree above it at all. Either way the picker falls
  // back to address-only rather than throwing - exactly how it behaved before uploading existed.
  const client = useOptionalApiClient();
  const workspace = useOptionalWorkspace();
  const workspaceId = workspace?.workspaceId ?? null;

  // The item this value is uploaded to belong to, as a child - the same relationship a note gives
  // an image dropped into it. `PropertyOwner` only promises a title and properties, because a
  // draft not yet saved has neither an id nor a parent to upload into; every real item does, and
  // this reads it duck-typed rather than widening the shared interface for one caller's need.
  const ownerCandidate = (item as unknown as { readonly id?: unknown }).id;
  const ownerId = typeof ownerCandidate === 'string' ? ownerCandidate : null;

  const canUpload = workspaceId !== null && client !== null;
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // The address a Remove just cleared, kept until the next edit so the click has a way back.
  // Removing is one click and the address is gone from the panel entirely - nothing else on screen
  // still holds it - so without this the only recovery is remembering a URL nobody reads. Local
  // rather than the global undo toast: the thing to put back is this control's own previous value,
  // and it is meaningless anywhere else.
  const [removed, setRemoved] = useState<string | null>(null);

  const addressRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);

  // The same discipline as `create-item-control.tsx`, for the same reasons: the address box is
  // focused when it appears because it was asked for - `autoFocus` is forbidden by the
  // accessibility rules, rightly, and clicking the address only to have to find the field again
  // is the click half-done - and focus goes back to the address when the editor closes, which has
  // to wait for the render that puts the address back.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      addressRef.current?.focus();
      return;
    }

    if (editing) {
      fieldRef.current?.focus();
    }
  }, [editing]);

  // Replaced whenever the stored value moves, during render rather than in an effect, so no render
  // ever shows a draft - or an open editor, or a refusal - belonging to a value that is gone.
  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
    setSent(stored);
    setEditing(false);
    setRefusal(null);
  }

  const fileItemId = fileImageReferenceItemId(stored);
  const isFileRef = fileItemId !== null;
  const filePreview = useFileImagePreview(client, fileItemId);
  const storedIsDisplayable = stored.length > 0 && isDisplayableImageValue(stored);
  const failed = isFileRef ? filePreview.status === 'error' : failedSrc === stored;
  const previewLoading = isFileRef && filePreview.status === 'loading';

  function commitReference(reference: string): void {
    // The same shape as a committed address below, minus the validation - a freshly uploaded
    // file's reference is trusted by construction, not by the address grammar.
    setRemoved(null);
    setDraft(reference);
    setSent(reference);
    setRefusal(null);
    returnFocus.current = editing;
    setEditing(false);
    onCommit(reference);
  }

  async function uploadFile(file: File): Promise<void> {
    if (uploading || workspaceId === null || client === null) return;

    if (!isImageFile(file)) {
      setRefusal(UNSUPPORTED_FILE_REFUSAL);
      return;
    }

    setUploading(true);
    setRefusal(null);
    try {
      const upload = await client.execute(
        fileResources.beginUpload({
          workspaceId,
          parentId: ownerId,
          fileName: file.name,
          mediaType: mediaTypeForFile(file),
          byteLength: file.size,
          idempotencyKey: `web-image-property:${crypto.randomUUID()}`,
        }),
      );
      const uploaded = await fileResources.uploadAndCompleteFile(client, upload, file);
      commitReference(fileImageReference(uploaded.itemId));
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message : 'The image could not be uploaded.');
    } finally {
      setUploading(false);
    }
  }

  function tryCommit(text: string): void {
    const trimmed = text.trim();

    // Any edit at all ends the undo window: the value the person is putting in is the one they
    // want, and an Undo still offering the address they removed two edits ago is a trap.
    setRemoved(null);

    // The same edit is never written twice: Enter followed by the blur it causes is one edit, and
    // an editor closed over an unchanged address is not an edit at all.
    if (trimmed === sent) {
      setRefusal(null);
      if (storedIsDisplayable) {
        returnFocus.current = editing;
        setEditing(false);
      }
      return;
    }

    if (trimmed.length === 0) {
      setDraft('');
      setSent('');
      setRefusal(null);
      onCommit(null);
      return;
    }

    if (!isFetchableImageAddress(trimmed)) {
      // Refused here, in place, and nothing is written. Left on screen to be corrected rather
      // than silently cleared: the person entered something, and discarding it would not say so.
      setDraft(trimmed);
      setEditing(true);
      setRefusal(refusalSentence(property.label));
      return;
    }

    setDraft(trimmed);
    setSent(trimmed);
    setRefusal(null);
    returnFocus.current = editing;
    setEditing(false);
    onCommit(trimmed);
  }

  // One drop target per state, wired identically: the address box while it is empty or being
  // edited, the whole set row otherwise, so dropping onto a picture replaces it.
  const dropZone = disabled
    ? {}
    : {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          // Preventing the default is what marks this element as a drop target at all; without it
          // the browser refuses the drop and the gesture silently does nothing.
          event.preventDefault();
          setDropping(true);
        },
        onDragLeave: () => {
          setDropping(false);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          event.preventDefault();
          setDropping(false);

          const address = droppedAddress(event.dataTransfer);
          if (address.length > 0) {
            tryCommit(address);
            return;
          }

          // A file drag carries neither `text/uri-list` nor `text/plain`, so there is no address
          // to read. Uploaded when this control has somewhere to send it - the same path
          // `uploadFile` gives a chosen file - and answered rather than dropped on the floor when
          // it does not; see `FILE_REFUSAL`.
          const file = event.dataTransfer.files[0];
          if (file === undefined) return;

          if (canUpload) {
            void uploadFile(file);
          } else {
            setRefusal(FILE_REFUSAL);
          }
        },
      };

  // The same visual answer the board's columns and the sidebar's rows give a hovering drag.
  const droppingFrame = dropping ? 'outline-2 -outline-offset-2 outline-accent' : '';

  // The quiet word beside the picture - Remove, and the Undo that replaces it - drawn the same way
  // so the swap is a change of word rather than a change of control.
  //
  // Hit target: the word is 12px type at the 1.45 line height that step carries, so 17.4px tall.
  // `before:-inset-y-2` adds 8px above and below (33.4px, past WCAG 2.5.8's 24px floor) and
  // `before:-inset-x-1` adds 4px each side. It used to be `before:-inset-2` - 8px each side - in a
  // `gap-2` row, which put Remove's hit area flush against the address button's right edge, so a
  // click at the end of a truncated URL deleted the picture instead of opening the editor. At 4px
  // against the `gap-3` rows below, 12 - 4 = 8px of dead space now separates the two.
  const quietControl =
    'relative shrink-0 font-body text-sm text-muted before:absolute before:-inset-x-1 before:-inset-y-2 hover:text-foreground';

  const undoButton =
    removed === null ? null : (
      <button
        type="button"
        aria-label={`Undo removing ${name}`}
        disabled={disabled}
        className={cn(quietControl, focusRing, disabledState)}
        onClick={() => {
          setRemoved(null);
          setDraft(removed);
          setSent(removed);
          setRefusal(null);
          onCommit(removed);
        }}
      >
        Undo
      </button>
    );

  // The address box: nothing stored yet, a stored value that is not an address (shown prefilled
  // with the reason, never handed to an img), or an edit somebody asked for.
  if (stored.length === 0 || !storedIsDisplayable || editing) {
    const shownError =
      error ??
      refusal ??
      (!storedIsDisplayable && stored.length > 0 ? refusalSentence(property.label) : null);

    return (
      <ImageShell
        density={density}
        label={property.label}
        name={name}
        required={property.required}
        error={shownError}
        hint={
          canUpload
            ? 'Paste or drag in a link to a picture, or choose one from this device.'
            : 'Paste or drag in a link to a picture.'
        }
      >
        {(control) => (
          // `gap-3` rather than the shell's own `gap-1`: the undo below carries an 8px vertical
          // hit-area extension, and a 12px gap leaves 4px of it clear of the address box above.
          <div className="flex flex-col gap-3">
            <Input
              {...control}
              type="url"
              tone={density === 'cell' ? 'plain' : 'default'}
              value={draft}
              required={property.required}
              disabled={disabled}
              ref={fieldRef}
              className={droppingFrame}
              onChange={(event) => {
                setDraft(event.target.value);
                setRefusal(null);
                setRemoved(null);
              }}
              onBlur={() => {
                tryCommit(draft);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  tryCommit(draft);
                }

                // A way out of an edit that keeps what is stored: without it, the only exits from
                // the editor are committing or blurring into a commit.
                if (event.key === 'Escape' && storedIsDisplayable) {
                  event.preventDefault();
                  setDraft(stored);
                  setRefusal(null);
                  returnFocus.current = editing;
                  setEditing(false);
                }
              }}
              onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
                const text = event.clipboardData.getData('text/plain').trim();
                if (text.length === 0) {
                  return;
                }

                // A pasted address is a finished edit - nobody pastes half a URL and keeps typing
                // - so it commits on the paste rather than waiting for a blur.
                event.preventDefault();
                tryCommit(text);
              }}
              {...dropZone}
            />

            {canUpload ? (
              // The hidden input carries the real file picker; the button is what a screen reader
              // and a coarse pointer both get a sensible target for. `sr-only` rather than
              // `hidden`, because an actually-hidden input cannot receive the click the button
              // forwards to it on every platform Testing Library exercises.
              <div className="flex items-center gap-2">
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="image/*"
                  disabled={disabled || uploading}
                  className="sr-only"
                  aria-label={`Choose an image file for ${name}`}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    const file = event.target.files?.[0] ?? null;
                    // Cleared immediately: choosing the same file twice in a row - after fixing
                    // and re-choosing it, say - must fire this `onChange` a second time, which a
                    // browser will not do while the input still holds that file.
                    event.target.value = '';
                    if (file !== null) void uploadFile(file);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || uploading}
                  onClick={() => {
                    uploadInputRef.current?.click();
                  }}
                >
                  {uploading ? 'Uploading picture…' : 'Choose image'}
                </Button>
              </div>
            ) : null}

            {undoButton === null ? null : <div className="flex">{undoButton}</div>}
          </div>
        )}
      </ImageShell>
    );
  }

  const thumbnail = previewLoading ? (
    // The uploaded file's own resolution ("useFileImagePreview") is asynchronous even on a warm
    // cache - it goes through Core for a fresh capability every time - so there is a real gap
    // between "set" and "drawn" that an address never has once decoded. Words rather than nothing,
    // for the same reason the failed case below is words: an unframed gap here would be the empty
    // box the gallery's cover forbids for exactly this reason.
    <Text variant="note" as="span" role="status">
      Loading picture…
    </Text>
  ) : failed ? (
    // Never the empty state: this property has a value, it is the fetch that broke, and words are
    // the only rendering that says which. Keyed on the failing address, so correcting it heals.
    // `role="status"` because the fetch fails asynchronously, after the box has already been drawn
    // and read: without it the sentence replaces a picture nobody was told about. Polite rather
    // than an alert - nothing is broken that the person did, and the address is still there to
    // correct. Not muted either: this is the control failing, and a failure set quieter than the
    // address beside it reads as a caption. (The gallery's identical sentence stays silent on
    // purpose - forty of these announcing themselves across a grid is noise; this is one control
    // the person is standing in.)
    <Text variant="note" as="span" role="status">
      {isFileRef
        ? 'This picture could not be loaded.'
        : 'This picture could not be loaded. Check the address.'}
    </Text>
  ) : (
    <Duotone
      // Empty on purpose: the picture carries nothing the address beside it does not say, and a
      // non-empty alt on a failed img collapses the reserved box (see cover-image.tsx).
      alt=""
      src={isFileRef ? (filePreview.status === 'ready' ? filePreview.url : '') : stored}
      className="absolute inset-0 size-full object-cover"
      onError={() => {
        // A file reference's own failure is `filePreview.status === 'error'`, driven by the
        // upload hook rather than this `img`'s load event - see `failed` above - so only an
        // address's fetch needs recording here.
        if (!isFileRef) setFailedSrc(stored);
      }}
    />
  );

  // A file reference is not a sentence anybody typed - showing `nix-file:<id>` here would be the
  // control leaking its own storage format. The button still opens the same editor (a chosen file
  // can be swapped for another, or for a pasted address), so it keeps a label rather than going
  // blank.
  const addressLabel = isFileRef ? 'Uploaded picture' : stored;

  const addressButton = (control: ImageControlProps): ReactElement => (
    <button
      {...control}
      type="button"
      ref={addressRef}
      title={addressLabel}
      disabled={disabled}
      // This is the control that opens the editor, so it has to clear WCAG 2.5.8 like everything
      // else in the row: 12px type at the step's 1.45 line height is 17.4px, and
      // `before:-inset-y-1` adds 4px above and below for 25.4px. `before:inset-x-0` leaves the
      // width alone - the button already spans the row, and widening it would push into the gap
      // this change just opened between it and Remove.
      className={cn(
        'relative min-w-0 flex-1 truncate text-left font-body text-sm text-foreground',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        focusRing,
        disabledState,
      )}
      onClick={() => {
        setEditing(true);
      }}
    >
      {addressLabel}
    </button>
  );

  const removeButton = (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      disabled={disabled}
      className={cn(quietControl, focusRing, disabledState)}
      onClick={() => {
        // Kept so the click has a way back - see `removed`. Held before the write, because the
        // write is what takes the address off the screen.
        setRemoved(stored);

        // Null, because that is what the contract's merge reads as "clear this one".
        onCommit(null);
      }}
    >
      Remove
    </button>
  );

  if (density === 'cell') {
    return (
      <ImageShell
        density={density}
        label={property.label}
        name={name}
        required={property.required}
        error={error ?? refusal}
      >
        {(control) => (
          <div {...dropZone} className={cn('flex items-center gap-3 px-2 py-1', droppingFrame)}>
            {failed ? (
              thumbnail
            ) : (
              // A reserved box, or a lazy thumbnail never enters the viewport and never loads.
              // A plain hairline rather than `blueprintFrame`: the frame's `rounded-md` is a
              // radius drawn for a card, and on a 24x40px cell it rounds most of the picture away.
              // The radius scale is meant to be sized to the box it turns.
              <span className="relative h-6 w-10 shrink-0 overflow-hidden rounded-sm border border-divider">
                {thumbnail}
              </span>
            )}
            {addressButton(control)}
            {undoButton ?? removeButton}
          </div>
        )}
      </ImageShell>
    );
  }

  return (
    <ImageShell
      density={density}
      label={property.label}
      name={name}
      required={property.required}
      error={error ?? refusal}
    >
      {(control) => (
        <div {...dropZone} className={cn('flex flex-col gap-2', droppingFrame)}>
          {/* One picture-shaped box for the thumbnail and for the words about it, so nothing
              reflows when a load fails - the same frame discipline as the gallery's CoverFrame. */}
          <div
            className={cn(
              blueprintFrame,
              'relative flex aspect-video w-full flex-col items-center justify-center gap-1 overflow-hidden p-3 text-center',
            )}
          >
            {thumbnail}
          </div>

          {/* `gap-3`, not `gap-2`: Remove's hit area reaches 4px past its word on each side, and
              12px of gap keeps that clear of the address button beside it. */}
          <div className="flex items-center gap-3">
            {addressButton(control)}
            {undoButton ?? removeButton}
          </div>
        </div>
      )}
    </ImageShell>
  );
}
