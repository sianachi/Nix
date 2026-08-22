import { isAllowedLinkAddress } from '@nix/editor-schema';
import { Button, Dialog, Field, Input } from '@nix/ui';
import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { z } from 'zod';

import { imageAddressSchema } from '../lib/image-address';

/** Which editor command is waiting for an address. */
export type EditorAddressKind = 'image' | 'link';

/** What the form hands back to the editor after validation. */
export interface EditorAddressValue {
  readonly address: string;
  readonly description: string;
}

export interface EditorAddressDialogProps {
  readonly kind: EditorAddressKind;
  readonly onCancel: () => void;
  readonly onSubmit: (value: EditorAddressValue) => void;
}

const linkAddressSchema = z
  .string()
  .trim()
  .min(1, 'Enter a link address.')
  .refine(
    isAllowedLinkAddress,
    'Enter a relative link or an address that uses a supported protocol.',
  );

/**
 * The editor's honest address boundary.
 *
 * A modal keeps the selection in the document while making room for a labelled address field,
 * validation, and alternative text when the address is for an image. It deliberately does not
 * show a file picker: this build has no media model, so accepting a local file here would promise
 * an upload that cannot complete.
 */
export function EditorAddressDialog({
  kind,
  onCancel,
  onSubmit,
}: EditorAddressDialogProps): ReactNode {
  const addressRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const image = kind === 'image';
  const title = image ? 'Insert image' : 'Add link';
  const addressLabel = image ? 'Image address' : 'Link address';
  const addressHint = image
    ? 'Paste a complete http or https address.'
    : 'Paste or type where this link should go.';
  const submitLabel = image ? 'Insert image' : 'Add link';

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();

    const parsed = (image ? imageAddressSchema : linkAddressSchema).safeParse(address);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid address.');
      addressRef.current?.focus();
      return;
    }

    onSubmit({ address: parsed.data, description: image ? description.trim() : '' });
  }

  return (
    <Dialog
      open
      title={title}
      onClose={onCancel}
      closeLabel={`Cancel ${image ? 'image insertion' : 'link creation'}`}
      initialFocus={addressRef}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Field label={addressLabel} required hint={addressHint} error={error}>
          {(control) => (
            <Input
              {...control}
              ref={addressRef}
              type="url"
              inputMode="url"
              autoComplete="url"
              required
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>

        {image ? (
          <Field
            label="Description"
            hint="Describe what the image shows. Leave this blank only when the image is decorative."
          >
            {(control) => (
              <Input
                {...control}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">{submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}
