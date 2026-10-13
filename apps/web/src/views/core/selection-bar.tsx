import { Button, Text, blueprintFrame, cn } from '@nix/ui';
import type { ReactNode } from 'react';

export interface SelectionBarProps {
  readonly count: number;
  readonly onMove?: (() => void) | undefined;
  readonly onClear: () => void;
  /** Extra per-view actions, drawn after Move. */
  readonly children?: ReactNode;
}

/** The bar a view shows while items are selected: the count, the shared actions, and a way out. */
export function SelectionBar({ count, onMove, onClear, children }: SelectionBarProps): ReactNode {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Selected items"
      className={cn(blueprintFrame, 'flex flex-wrap items-center gap-3 bg-surface p-2')}
    >
      <Text variant="body" as="span" aria-live="polite">
        {`${String(count)} selected`}
      </Text>
      {onMove ? (
        <Button variant="secondary" onClick={onMove}>
          Move to…
        </Button>
      ) : null}
      {children}
      <Button variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
