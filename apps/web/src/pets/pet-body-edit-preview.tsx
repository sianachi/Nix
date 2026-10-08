import { Text, cn, focusRing } from '@nix/ui';
import type { ReactElement } from 'react';
import type { PreviewBodyEdit } from '@nix/structure-spec';

/** One side of the comparison: a label in words (never colour alone) and the full text in a
 * focusable scroll region, so nothing the owner is approving hides behind a fold. */
function TextSide({
  label,
  text,
  empty,
}: {
  readonly label: string;
  readonly text: string;
  readonly empty: string;
}): ReactElement {
  const lineCount = text ? text.split('\n').length : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Text variant="note" tone="muted">
        {label} ({String(lineCount)} line{lineCount === 1 ? '' : 's'})
      </Text>
      <div
        role="region"
        aria-label={label}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
        tabIndex={0}
        className={cn(
          'max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded border border-divider p-2',
          focusRing,
        )}
      >
        {text ? <Text variant="note">{text}</Text> : <Text variant="note">{empty}</Text>}
      </div>
    </div>
  );
}

/** The text a section or passage edit replaces and the text it leaves, side by side when the
 * panel is wide enough and stacked when it is not. Both sides are plain text: the model chose
 * the new one, so it is never rendered as Markdown. */
export function PetBodyEditPreview({ edit }: { readonly edit: PreviewBodyEdit }): ReactElement {
  return (
    <div className="@container flex flex-col gap-2">
      <Text variant="note" tone="muted">
        The edited part of the note, before and after
      </Text>
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
        <TextSide label="Text now" text={edit.before} empty="(empty)" />
        <TextSide
          label="Text after this change"
          text={edit.after}
          empty="(removed: nothing replaces it)"
        />
      </div>
    </div>
  );
}
