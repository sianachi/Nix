import { Button, Icon, Text } from '@nix/ui';
import { X } from 'lucide-react';
import { type ReactElement } from 'react';
import { type SharedContext } from '../state/use-message-context';

export function ContextChips({
  chips,
  onRemove,
}: {
  readonly chips: readonly SharedContext[];
  readonly onRemove: (context: SharedContext) => void;
}): ReactElement | null {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Notes sent with your message" className="flex min-w-0 flex-col gap-2">
      {chips.map((context) => (
        <li
          key={`${context.itemId}:${context.sharedText}`}
          className="flex min-w-0 items-center justify-between gap-2 rounded border border-divider bg-surface px-3 py-2"
        >
          <Text variant="note" className="truncate">
            {context.label}
          </Text>
          <Button
            variant="icon"
            aria-label={`Remove ${context.label}`}
            onClick={() => {
              onRemove(context);
            }}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
