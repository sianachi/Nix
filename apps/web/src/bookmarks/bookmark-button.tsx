import { Button, Icon, cn, focusRing } from '@nix/ui';
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';

import { useBookmarksStore, useIsKept } from './use-bookmarks';

/**
 * The one control that keeps and releases an item, wherever it appears.
 *
 * **One component for every touchpoint**, because a star that means "kept" in the tree and
 * something subtly different in the editor is two things a reader has to learn. It reads the shelf
 * from the store rather than from a prop, so a row and the open document cannot disagree about the
 * same item - which they would the moment one of them was keeping its own copy.
 *
 * **It is a toggle, and it says which state it is in.** `aria-pressed` rather than swapping the
 * accessible name between "Bookmark" and "Remove bookmark": a toggle button is a thing with a
 * state, and a screen reader announces that state itself. Two names for one control would make the
 * same key press sound like it did two different things.
 */

export interface BookmarkButtonProps {
  readonly itemId: string;

  /** What the item is called, so the control can name what it acts on rather than "this". */
  readonly title: string;

  /**
   * Renders as a bare icon on a hover row rather than as a boxed control.
   *
   * The tree's row controls are icons and the editor's chrome is boxed; the difference is the
   * caller's to state, because only the caller knows what it sits beside.
   */
  readonly compact?: boolean | undefined;

  readonly className?: string | undefined;
}

export function BookmarkButton(props: BookmarkButtonProps): ReactNode {
  const { itemId, title, compact = false, className = '' } = props;
  const kept = useIsKept(itemId);
  const toggle = useBookmarksStore((state) => state.toggle);

  const label = `Bookmark ${title.length > 0 ? title : 'Untitled'}`;

  if (compact) {
    return (
      <button
        type="button"
        aria-label={label}
        title={kept ? 'Unpin from sidebar' : 'Pin to sidebar'}
        aria-pressed={kept}
        onClick={(event) => {
          // The tree's rows open an item on click, and the editor's chrome sits inside other
          // controls. Neither should fire because somebody aimed at the star.
          event.stopPropagation();
          void toggle(itemId);
        }}
        className={cn(
          focusRing,
          'rounded-sm p-1 text-muted hover:bg-surface hover:text-accent-text',
          kept ? 'text-accent-text' : '',
          className,
        )}
      >
        {/* `fill-current` is the whole difference between kept and not: a filled star and an
            outlined one, which is the convention every application that has stars uses. The colour
            change beside it is the second signal, so this does not rest on fill alone. */}
        <Icon icon={Star} size="sm" className={kept ? 'fill-current' : ''} />
      </button>
    );
  }

  return (
    <Button
      variant="icon"
      aria-label={label}
      title={kept ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-pressed={kept}
      className={className}
      onClick={() => {
        void toggle(itemId);
      }}
    >
      <Icon icon={Star} size="sm" className={kept ? 'fill-current text-accent-text' : ''} />
    </Button>
  );
}
