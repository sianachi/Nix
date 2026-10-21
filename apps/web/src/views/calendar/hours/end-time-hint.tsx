import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

interface EndTimeHintProps {
  readonly canAddEnd: boolean;
  readonly onAdd: () => void;
}

/**
 * Said out loud, because the alternative is a foot that is simply not there: without an end
 * property an item is a point, there is nowhere to write a length, and a reader trying to stretch
 * one would find nothing to take hold of and no reason why.
 */
export function EndTimeHint(props: EndTimeHintProps): ReactNode {
  const { canAddEnd, onAdd } = props;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Text as="p" variant="caption" tone="muted">
        {canAddEnd
          ? 'Items here have a start but no end, so they cannot be stretched.'
          : 'Items here have a start but no end, so they cannot be stretched. Choose an End property in this view’s settings to give them a length.'}
      </Text>
      {canAddEnd ? (
        <Button
          variant="secondary"
          onClick={() => {
            onAdd();
          }}
        >
          Add end times
        </Button>
      ) : null}
    </div>
  );
}
