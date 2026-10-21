import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

export function ImportCount({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}): ReactNode {
  return (
    <div className="rounded-md bg-surface p-2 text-center">
      <Text variant="h3">{String(value)}</Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </div>
  );
}
