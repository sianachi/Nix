import { Card, Text } from '@nix/ui';
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
    <Card title={title} kicker="Template library">
      <Text tone="muted">{detail}</Text>
      {children}
    </Card>
  );
}
