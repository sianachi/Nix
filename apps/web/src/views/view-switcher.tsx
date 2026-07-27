import { Icon } from '@nix/ui';
import { CalendarDays, Columns3, List as ListIcon, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { isKnownViewKind, type View } from './container-model';

/**
 * The per-container view switcher.
 *
 * **Scoped to a container, and that is the whole point.** The application used to carry a
 * top-level tab strip with "Board" on it, which said that a board was a place you go. It is not:
 * it is a way of looking at one folder, and the same folder can be a list a moment later. So the
 * switcher lives above the container's contents and moves with you.
 *
 * A view that cannot currently render is still offered, marked, and explains itself when selected.
 * Hiding it would be worse: somebody who configured a board and then deleted the property it
 * groups by needs to find that board in order to fix it, and a switcher that quietly dropped it
 * would leave them with no way back to their own configuration.
 */

export interface ViewSwitcherProps {
  readonly views: readonly View[];
  readonly unrenderable: readonly string[];
  readonly activeViewId: string | null;
  readonly onSelect: (viewId: string) => void;
}

const KIND_ICONS = {
  list: ListIcon,
  board: Columns3,
  calendar: CalendarDays,
} as const;

export function ViewSwitcher(props: ViewSwitcherProps): ReactNode {
  const { views, unrenderable, activeViewId, onSelect } = props;

  if (views.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label="Views"
      className="flex items-center gap-1 border-b border-divider px-4 py-1.5"
    >
      {views.map((view) => {
        const active = view.id === activeViewId;
        const broken = unrenderable.includes(view.id);
        const icon = isKnownViewKind(view.kind) ? KIND_ICONS[view.kind] : ListIcon;

        return (
          <button
            key={view.id}
            type="button"
            // aria-current rather than aria-selected: these are not tabs in the ARIA sense - each
            // one is a destination within the container, and the pattern a screen reader should
            // announce is "current", not a tablist we would then owe arrow-key navigation.
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              onSelect(view.id);
            }}
            className={[
              'flex items-center gap-1.5 border px-2 py-1 text-[12px]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              active
                ? 'border-divider bg-foreground/7 text-foreground'
                : 'border-transparent text-neutral-700 hover:bg-foreground/5',
            ].join(' ')}
          >
            <Icon icon={icon} size="sm" />
            {view.name}
            {broken ? (
              <>
                <Icon icon={TriangleAlert} size="sm" />
                {/* The mark is not colour alone, and it is not icon alone either: a name a screen
                    reader reads out has to carry the same warning the eye gets. */}
                <span className="sr-only">(needs attention)</span>
              </>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
