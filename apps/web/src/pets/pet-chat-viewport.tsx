import { Button, focusRing } from '@nix/ui';
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

/** One scroll surface: responses and their approvals stay together above the composer. */
export function PetChatViewport({
  latestKey,
  children,
}: {
  readonly latestKey: string;
  readonly children: ReactNode;
}): ReactElement {
  const viewport = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);

  function showLatest() {
    const node = viewport.current;
    const latest = node?.querySelector('[data-pet-latest-message]');
    if (!node) return;
    // Start at the beginning of a long reply, not its last line. Never scroll the workspace.
    node.scrollTop = latest
      ? node.scrollTop + latest.getBoundingClientRect().top - node.getBoundingClientRect().top
      : node.scrollHeight;
    following.current = true;
    setUnread(false);
  }

  useLayoutEffect(() => {
    if (following.current) showLatest();
    else setUnread(true);
  }, [latestKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={viewport}
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
        // Scrollable conversation content must be reachable for keyboard scrolling.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className={`flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-4 ${focusRing}`}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
          if (following.current) setUnread(false);
        }}
      >
        {children}
      </div>
      {unread ? (
        <Button variant="secondary" className="shrink-0 self-center" onClick={showLatest}>
          Show latest reply
        </Button>
      ) : null}
    </div>
  );
}
