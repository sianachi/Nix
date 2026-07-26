import { CircleAlert, Inbox, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { Blueprint, Icon, Text } from '@nix/ui';

/**
 * The honest states, as reusable panels. Every data-bearing view in the app
 * reaches for these rather than inventing its own placeholder, so the
 * vocabulary users learn stays constant and no view can quietly skip a state.
 *
 * Accessibility, decided once here:
 *   - LoadingPanel is a polite live region with `aria-busy`, and it names what
 *     it is waiting for. A spinner with no name is not a state, it is a shrug.
 *   - ErrorPanel is `role="alert"`, so a failure is announced, and it renders
 *     its recovery affordance whenever one exists.
 *   - EmptyPanel and PartialNotice are `role="status"`: information, not an
 *     interruption.
 *
 * Each panel is a blueprint object - hairline frame, registration marks, no
 * fill - so a state placeholder sits in the page as a first-class object
 * rather than as grey filler.
 */

function PanelFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return <Blueprint className="p-6">{children}</Blueprint>;
}

const PANEL_BODY = 'flex flex-col items-start gap-3';

export function LoadingPanel({ label }: { readonly label: string }): ReactElement {
  return (
    <PanelFrame>
      <div aria-busy={true} aria-live="polite" className={PANEL_BODY}>
        <Icon icon={LoaderCircle} className="animate-spin text-accent" />
        <Text variant="h3">Loading {label}</Text>
        <Text tone="muted">
          Waiting on {label}. Nothing has failed; this view will change on its own.
        </Text>
      </div>
    </PanelFrame>
  );
}

export function EmptyPanel({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <PanelFrame>
      <div role="status" className={PANEL_BODY}>
        <Icon icon={Inbox} className="text-accent" />
        <Text variant="h3">{title}</Text>
        <Text tone="muted">{detail}</Text>
        {action}
      </div>
    </PanelFrame>
  );
}

export function ErrorPanel({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <PanelFrame>
      <div role="alert" className={PANEL_BODY}>
        <Icon icon={CircleAlert} className="text-accent" />
        <Text variant="h3">{title}</Text>
        <Text tone="muted">{detail}</Text>
        {action}
      </div>
    </PanelFrame>
  );
}

/**
 * Rendered alongside real content, never instead of it: what is on screen is
 * usable, and this says which part of it is not ready yet.
 */
export function PartialNotice({ pending }: { readonly pending: string }): ReactElement {
  return (
    <div
      role="status"
      className="flex items-start gap-2 border border-divider p-3 font-body text-sm text-accent-text"
    >
      <Icon icon={TriangleAlert} className="size-4" />
      <span>{pending}</span>
    </div>
  );
}
