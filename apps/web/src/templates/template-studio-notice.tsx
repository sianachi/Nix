import { Blueprint, Icon, Text } from '@nix/ui';
import { LayoutTemplate } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

export function StudioNotice({
  title,
  detail,
  children,
  attention = false,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
  readonly attention?: boolean;
}): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (attention) headingRef.current?.focus();
  }, [attention, title]);

  return (
    <div
      role={attention ? 'alert' : undefined}
      aria-live={attention ? 'assertive' : undefined}
      className="flex min-h-0 flex-1 items-center justify-center p-6"
    >
      <Blueprint className="flex max-w-lg flex-col items-start gap-3 p-6">
        <Icon icon={LayoutTemplate} size="md" />
        <h1 ref={headingRef} tabIndex={attention ? -1 : undefined}>
          <Text variant="h2" as="span">
            {title}
          </Text>
        </h1>
        <Text tone="muted">{detail}</Text>
        {children}
      </Blueprint>
    </div>
  );
}
