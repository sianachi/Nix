import { Blueprint, Text } from '@nix/ui';
import type { ReactNode } from 'react';

export function LibraryNotice({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <Blueprint className="flex flex-col items-start gap-3 p-3">
      <Text variant="h4" as="h2">
        {title}
      </Text>
      <Text tone="muted">{detail}</Text>
      {children}
    </Blueprint>
  );
}
