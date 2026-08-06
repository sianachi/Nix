import { Icon, focusRing } from '@nix/ui';
import { FileText, List as ListIcon, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { DOCUMENT_VIEW, type View } from './container-model';
import { findViewKind } from './view-kinds';

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
 *
 * **The document is the first entry, and it is not one of the views.** An item's body and its
 * views answer different questions - the body is the item's own content, a view renders its
 * children - but only one of them is on screen at a time, so one control chooses between them.
 * That is why the document is passed as a flag rather than smuggled in as a fourth view kind: it
 * has no configuration, cannot be reordered or deleted, and is the one entry every item has.
 */

export interface ViewSwitcherProps {
  readonly views: readonly View[];
  readonly unrenderable: readonly string[];
  readonly activeViewId: string | null;
  readonly onSelect: (viewId: string) => void;

  /** What to call the item's own body. Omit to leave the document out entirely. */
  readonly documentLabel?: string;
}

export function ViewSwitcher(props: ViewSwitcherProps): ReactNode {
  const { views, unrenderable, activeViewId, onSelect, documentLabel } = props;

  // Nothing to choose between. An item nobody has configured a view on shows its body and no
  // chrome at all, which is every plain note - a lone "Document" tab would be a control with one
  // option, taking up a row to say what the screen already shows.
  if (views.length === 0) {
    return null;
  }

  return (
    // px-8, not px-4: this nav's own box sits in the same left-reading edge as the item header
    // above it (`ItemHeader`, `px-8 pb-3 pt-4`) and the document body below it (`NoteEditor`,
    // `px-8 py-6`) - the first tab's border, not its label, is what lines up at that edge, the
    // label sitting a further px-2 in from the tab's own padding. At px-4 the row sat 13.6px inside
    // where the title and the prose both start, which is exactly the "gap between a view's chrome
    // and its content" the owner report named. True of the header and the document body only: a
    // view's own content (board, gallery, list, calendar, timeline) carries no horizontal padding
    // of its own at all, and this correction widens rather than closes that separate mismatch - see
    // the rhythm specimen's own note on the point (`rhythm-specimen.tsx`).
    <nav aria-label="Views" className="flex items-center gap-1 px-8 py-1.5">
      {documentLabel === undefined ? null : (
        <SwitcherTab
          icon={FileText}
          label={documentLabel}
          active={activeViewId === DOCUMENT_VIEW}
          broken={false}
          onSelect={() => {
            onSelect(DOCUMENT_VIEW);
          }}
        />
      )}

      {views.map((view) => {
        const active = view.id === activeViewId;
        const broken = unrenderable.includes(view.id);
        // A kind this build does not know still gets a tab - the view exists and hiding it would
        // make it unreachable - but it borrows the list icon, since there is no glyph for it.
        const icon = findViewKind(view.kind)?.icon ?? ListIcon;

        return (
          <SwitcherTab
            key={view.id}
            icon={icon}
            label={view.name}
            active={active}
            broken={broken}
            onSelect={() => {
              onSelect(view.id);
            }}
          />
        );
      })}
    </nav>
  );
}

interface SwitcherTabProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active: boolean;
  readonly broken: boolean;
  readonly onSelect: () => void;
}

function SwitcherTab({ icon, label, active, broken, onSelect }: SwitcherTabProps): ReactNode {
  return (
    <button
      type="button"
      // aria-current rather than aria-selected: these are not tabs in the ARIA sense - each one is
      // a destination within the item, and the pattern a screen reader should announce is
      // "current", not a tablist we would then owe arrow-key navigation.
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      className={[
        'flex items-center gap-1.5 border px-2 py-1 text-sm',
        focusRing,
        active
          ? 'border-divider bg-foreground/7 text-foreground'
          : 'border-transparent text-muted hover:bg-foreground/5',
      ].join(' ')}
    >
      <Icon icon={icon} size="sm" />
      {label}
      {broken ? (
        <>
          <Icon icon={TriangleAlert} size="sm" />
          {/* The mark is not colour alone, and it is not icon alone either: a name a screen reader
              reads out has to carry the same warning the eye gets. */}
          <span className="sr-only">(needs attention)</span>
        </>
      ) : null}
    </button>
  );
}
