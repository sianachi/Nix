import { Icon, focusRing } from '@nix/ui';
import { Bookmark, CalendarDays, Network, NotebookText, type LucideIcon } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

/**
 * The navigation rail: the handful of ways to look at the whole workspace at once.
 *
 * A workspace tree answers "which note", one at a time. Calendar, Graph and Bookmarks each answer
 * a different question about every note together - which is why none of them is an item in the
 * tree, and why they need a destination of their own rather than a row inside it. Notes sits beside
 * them as the tree's own destination, so the rail names a complete set of ways into the workspace
 * rather than three extras bolted beside an unlabelled default. The strip itself sits outboard of
 * the tree, so it stays put while the tree scrolls, resizes, or - on a phone - slides away entirely.
 *
 * ## Why this lives in the app and not in `packages/ui`
 *
 * `<Nav>` (packages/ui/src/controls/Nav.tsx) is already the design system's "a list of links, one
 * of which may be the page you are on", and this is deliberately not it. Two things differ, and
 * both are product facts rather than design-system ones. `<Nav>` requires a visible label per item
 * - correctly, for a settings sidebar - while a rail is icon-only and carries its name for
 * assistive technology alone. And a rail is one tab stop with the arrow keys moving inside it,
 * which `<Nav>` does not do and should not learn for a single caller. What is left after those two
 * is a component that knows this application's own destinations and imports this application's
 * router, neither of which belongs in a package that `apps/*` depend on.
 *
 * ## Keyboard: one tab stop, arrows inside
 *
 * The APG's roving tabindex, the same convention `views/use-roving-grid.ts` implements for the
 * hour grid, and for the same reason: a set of like controls should cost one Tab press to pass,
 * not one per control. Three items make that a small win today and a correct habit regardless -
 * the rail is where destinations accumulate.
 *
 * It is spelled out here rather than reusing that hook, which is built for a grid whose slots the
 * caller does not render (it finds buttons by `querySelector` and writes `tabindex` onto the DOM,
 * precisely because `CreateItemControl` exposes no tabindex prop). This component renders its own
 * links, so the entry point is a prop it passes, not an attribute it has to reach into the DOM to
 * set. Down/Up move by one and Home/End jump to the ends, all clamped rather than wrapped - the
 * same no-wrap choice the grid makes, so the ends of a keyboard-navigable set are findable by feel
 * everywhere in the product.
 *
 * ## Where you are is never colour alone
 *
 * The current destination carries `aria-current="page"`, which is the only signal that reaches
 * somebody who cannot see the accent wash. Same contract, and same reasoning, as `<Nav>`'s.
 */

interface RailDestination {
  /** The route. Also the identity used to decide which destination is current. */
  readonly to: string;

  /**
   * The accessible name, rendered as visually hidden text rather than an `aria-label`: real text
   * content is what a translation pass, a browser's find-in-page, and every accessible-name
   * calculation agree on. Also given as `title`, so a pointer user can discover what an unlabelled
   * glyph means without a tooltip component.
   */
  readonly label: string;

  readonly icon: LucideIcon;
}

/**
 * The destinations, in the order they appear.
 *
 * **Notes is first, and it is the only one of the four that is not a different kind of view.**
 * Calendar, Graph and Bookmarks each collapse the whole workspace into one picture drawn a
 * different way; Notes is the tree itself - the one destination that is not really "elsewhere",
 * only home. Placing it first, rather than leaving `/` reachable only through the logo, is what
 * makes the rail read as a complete set of destinations instead of three extra ones bolted beside
 * an unlabelled default.
 *
 * `Network` rather than `Workflow` for the graph: a workflow glyph is a flowchart - boxes in a
 * sequence, with a direction - and the link graph has neither. `Network`'s undirected nodes and
 * edges are what the view actually shows.
 */
const DESTINATIONS: readonly RailDestination[] = [
  { to: '/', label: 'Notes', icon: NotebookText },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/graph', label: 'Graph', icon: Network },
  { to: '/bookmarks', label: 'Bookmarks', icon: Bookmark },
];

export interface NavRailProps {
  /**
   * Called after a destination is followed. The shell uses it to dismiss the narrow-viewport
   * drawer, which would otherwise stay open over the destination it was just asked to leave for.
   */
  readonly onNavigate?: () => void;
}

export function NavRail({ onNavigate }: NavRailProps): ReactNode {
  const { pathname } = useLocation();

  // Which link is the rail's single tab stop. Null until somebody has actually put focus in here,
  // so the entry point is the current destination by default - derived from the URL rather than
  // copied into state, which keeps it right after a navigation the rail did not make.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Identity is a dependency of `.focus()` - the arrow keys have to move focus to an element this
  // component rendered, and there is no other way to reach it. `useRef` over `useState` because
  // filling this in must not re-render.
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const currentIndex = DESTINATIONS.findIndex((destination) => destination.to === pathname);
  const entryIndex = focusedIndex ?? Math.max(currentIndex, 0);

  // Handled on the link rather than on the list around it: a key press acts from wherever focus
  // actually is, and hanging a keyboard listener on a `<ul>` would be putting interaction on an
  // element with no interactive role (which `jsx-a11y/no-noninteractive-element-interactions` says
  // out loud, correctly - a listener there is only reachable because a real control inside it
  // bubbled the event).
  function onKeyDown(event: KeyboardEvent<HTMLElement>, from: number): void {
    let next = from;

    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(from + 1, DESTINATIONS.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(from - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = DESTINATIONS.length - 1;
        break;
      default:
        return;
    }

    // The rail must not also scroll the page: one press, one movement.
    event.preventDefault();
    setFocusedIndex(next);
    linkRefs.current[next]?.focus();
  }

  return (
    // `bg-surface`, the same ground the tree sits on: the rail stretches the full height of the
    // shell, past the header above the tree as well as beside the tree itself, and one surface for
    // that whole strip is what keeps it reading as one region rather than two stacked patches.
    // Because that surface is the one the tree already sits on, the two would have no boundary at
    // all where they meet - CLAUDE.md's own case for `border-divider`, reached for "only where two
    // regions of the same colour genuinely meet". The border runs the rail's full height rather
    // than only alongside the tree, so it stays one continuous line rather than a border that
    // starts partway down. Named, because a shell with a rail and a workspace tree has more than
    // one way to move around and "navigation, navigation" is not a landmark list anybody can use.
    <nav aria-label="Destinations" className="flex shrink-0 border-r border-divider bg-surface">
      <ul className="flex list-none flex-col items-center gap-1 px-1 py-2">
        {DESTINATIONS.map((destination, index) => {
          const current = index === currentIndex;

          return (
            <li key={destination.to}>
              <Link
                ref={(node) => {
                  linkRefs.current[index] = node;
                }}
                to={destination.to}
                title={destination.label}
                aria-current={current ? 'page' : undefined}
                tabIndex={index === entryIndex ? 0 : -1}
                onKeyDown={(event) => {
                  onKeyDown(event, index);
                }}
                onFocus={() => {
                  // Keeps the tab stop where focus really is, including after a pointer click,
                  // so tabbing out and back returns to where the person just was.
                  setFocusedIndex(index);
                }}
                onClick={onNavigate}
                className={`flex size-(--control-lg) items-center justify-center rounded-md ${focusRing} ${
                  current
                    ? // The wash is a filled shape where the others have none, so the current
                      // destination is not told apart by hue alone even before `aria-current`.
                      'bg-accent/15 text-accent-text'
                    : 'text-muted hover:bg-foreground/7 hover:text-foreground'
                }`}
              >
                <Icon icon={destination.icon} size="sm" />
                <span className="sr-only">{destination.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
