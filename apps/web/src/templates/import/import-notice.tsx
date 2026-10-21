import { Blueprint, Icon, Text } from '@nix/ui';
import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

/** A full-pane notice for the states where the import form cannot be shown. */
export function ImportNotice({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-3 sm:p-5">
      <Blueprint className="flex min-w-0 max-w-lg flex-col items-start gap-3 p-3 sm:p-5">
        <Icon icon={ShieldCheck} size="md" />
        <Text variant="h3" as="h1">
          {title}
        </Text>
        <Text tone="muted">{detail}</Text>
        {children === undefined ? null : <div className="flex flex-wrap gap-2">{children}</div>}
      </Blueprint>
    </div>
  );
}
