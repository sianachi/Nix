import { Button, Icon, Text } from '@nix/ui';
import { type PetConnection } from '@nix/api-client';
import { type LucideIcon } from 'lucide-react';
import { type ReactElement } from 'react';
import { type ProgramPiece } from '../../../openui/fence';
import { PetMessageText } from '../../pet-message-text';

export function PetMessageRow({
  message,
  petName,
  workspaceId,
  latest,
  editor,
  action,
  onAsk,
  applyWithoutAsking,
  earlierPieces,
  followsLockedRead,
  noteScope,
}: {
  readonly message: NonNullable<PetConnection['messages']>[number];
  readonly petName: string;
  readonly workspaceId: string;
  readonly latest: boolean;
  /** Replaces the message text while the message is being edited. */
  readonly editor?: ReactElement | undefined;
  /** The one thing the last turn offers: "Edit" on the user message, "Regenerate" on the reply. */
  readonly action?:
    { readonly label: string; readonly icon: LucideIcon; readonly onClick: () => void } | undefined;
  /** A generated-UI button's request to the pet, which goes to the composer rather than out. */
  readonly onAsk?: ((message: string) => void) | undefined;
  readonly applyWithoutAsking: boolean;
  readonly earlierPieces?: readonly ProgramPiece[] | undefined;
  readonly followsLockedRead: boolean;
  readonly noteScope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
}): ReactElement {
  if (message.role === 'system')
    return (
      <div data-pet-latest-message={latest ? '' : undefined} className="flex justify-center">
        <Text variant="caption" tone="muted">
          {message.text}
        </Text>
      </div>
    );
  const fromUser = message.role === 'user';
  // A streaming draft (id contains `:draft:`) is never durable text yet, so it is kept out of
  // the viewport's `aria-live="polite"` announcement (a screen reader would otherwise read it
  // out token by token) and shown with a caret instead.
  const isDraft = message.id.includes(':draft:');
  return (
    <div
      data-pet-latest-message={latest ? '' : undefined}
      data-pet-from-user={fromUser ? '' : undefined}
      // Nit 16: the whole draft row - its sr-only speaker label included - opts out of the
      // viewport's live region while streaming, not only the text itself; otherwise the label
      // alone would still be announced token turn by token as the row keeps re-rendering.
      aria-live={isDraft ? 'off' : undefined}
      className={`flex min-w-0 shrink-0 flex-col gap-1 ${fromUser ? 'items-end' : 'items-start'}`}
    >
      <Text as="span" variant="note" className="sr-only">
        {fromUser ? 'You said' : `${petName} said`}
      </Text>
      <div
        className={
          fromUser
            ? 'min-w-0 max-w-[90%] rounded-lg bg-surface px-3 py-2 @sm:max-w-[85%]'
            : 'min-w-0 w-full'
        }
      >
        {editor ?? (
          <PetMessageText
            text={message.text}
            workspaceId={workspaceId}
            format={fromUser ? 'plain' : 'markdown'}
            streaming={isDraft}
            onAsk={onAsk}
            applyWithoutAsking={applyWithoutAsking}
            earlierPieces={earlierPieces}
            followsLockedRead={followsLockedRead}
            noteScope={noteScope}
            {...(isDraft ? {} : { messageId: message.id })}
          />
        )}
        {isDraft ? (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-0.5 align-middle bg-foreground motion-safe:animate-pulse"
          />
        ) : null}
      </div>
      {action ? (
        <Button variant="ghost" onClick={action.onClick}>
          <Icon icon={action.icon} size="sm" />
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
