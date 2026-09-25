import { type LucideIcon } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { Icon } from '../primitives/Icon';
import { disabledState, focusRingInset, inkWashStates } from '../primitives/interaction';
import { placeFloatingMenu, readViewportBounds } from '../primitives/placement';

/**
 * <Menu> - a button that discloses a list of actions and links.
 *
 * The WAI-ARIA menu-button pattern, built once so it stops being built once per call site. Two
 * places had it before this existed - the workspace switcher and the profile menu - and each got
 * the same two things wrong on its own: a panel with a literal pixel width that ran off a narrow
 * phone screen, and a trigger sized for a mouse. Fixing both here fixes every menu that adopts it,
 * and the next one for free.
 *
 * **Keyboard.** Enter, Space and ArrowDown open the menu and move focus to its first item (ArrowUp
 * opens onto the last one, the pattern's usual courtesy for "give me the bottom of the list").
 * Inside the open menu, ArrowUp and ArrowDown move between items and wrap at the ends, Home and End
 * jump to the first and last, Escape closes the menu and returns focus to the trigger, and Tab
 * closes it without fighting the browser for where focus goes next. Typeahead is not implemented -
 * every menu built on this so far is short enough that scanning beats typing.
 *
 * **Dismissal.** A pointerdown outside the trigger and panel closes the menu; so does choosing an
 * item. Neither is optional, because a menu that is still open after you have told it what you
 * want is a menu that does not trust its own list.
 *
 * **Placement.** The panel anchors below the trigger and is measured against
 * `window.visualViewport` - the same source `Dialog.tsx` reads for the on-screen keyboard - so it
 * flips above the trigger when there is not enough room below, and is clamped 8px inside the
 * viewport either way rather than clipped by it. The geometry itself is `placeFloatingMenu`, the
 * same primitive the editor's slash menu, reference picker and bubble menu place themselves
 * with - one tested implementation rather than this component re-deriving its own. Below the `sm`
 * breakpoint this measurement is skipped and the panel becomes a full-width bottom sheet instead,
 * `Dialog.tsx`'s other device concession: a menu is exactly as unable to predict a phone's safe
 * area or its keyboard as a dialog is, so it inherits the same `env(safe-area-inset-bottom)`
 * padding rather than a second, slightly different guess at the same problem.
 *
 * **Items are 44px tall under `pointer-coarse:`** - `Button.tsx`'s `--control-lg` step, reached
 * the same way: a fine pointer gets the compact row, a finger gets the touch target the platform
 * guidelines ask for.
 *
 * **Destructive tone** darkens the label's weight rather than reaching for a colour: the token
 * sheet carries no danger role today (see `docs/adr/` before adding one - every other tone in this
 * package is a role, not a colour, and a one-off red here would be the first exception), so this is
 * the honest treatment available without inventing a raw value the guide forbids.
 */

export interface MenuAction {
  readonly kind?: 'action';
  /** Stable identity for the list; falls back to `label` when every label in the menu is unique. */
  readonly key?: string;
  readonly label: string;
  /** Decorative - the label already carries the name. */
  readonly icon?: LucideIcon;
  /** Marks a destructive action (leave, delete, sign out) without a colour the system does not have. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export interface MenuLink {
  readonly kind: 'link';
  readonly key?: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly destructive?: boolean;
  /** The destination, in the platform's own vocabulary; `renderLink` renames it for a router. */
  readonly href: string;
  /** Anything the caller needs to run alongside navigating, beyond closing the menu. */
  readonly onSelect?: () => void;
}

export interface MenuSeparator {
  readonly kind: 'separator';
}

/** Handed to a `content` entry's render function - the one thing bespoke content cannot do for
 * itself, since it did not open the menu. */
export interface MenuContentHelpers {
  /** Drops the panel without returning focus to the trigger - the click already moved it. */
  readonly close: () => void;
}

/**
 * Something in the panel that is not a command - an identity block, a settings widget, a region of
 * ordinary navigation links - drawn exactly as given and left out of arrow-key navigation and the
 * roving tabindex, the same way the profile menu's appearance switcher and account header always
 * have been. Its own interactive content (a radio group, a link) keeps its ordinary place in the
 * tab order; it is only the menu's up/down/Home/End model that does not reach it, because none of
 * that model's questions - "which command is this" - have an answer for a fieldset or a region of
 * links to other pages.
 *
 * A function rather than a plain node when that content needs to close the menu itself - a link
 * to another page, say - since only the menu knows how.
 */
export interface MenuContent {
  readonly kind: 'content';
  readonly key?: string;
  readonly content: ReactNode | ((helpers: MenuContentHelpers) => ReactNode);
}

export type MenuEntry = MenuAction | MenuLink | MenuSeparator | MenuContent;

/**
 * What a link item needs to be drawn. The same shape `Nav.tsx`'s `renderLink` uses, for the same
 * reason: this package does not know about routers, so the consumer supplies the routing component
 * and renames `href` to whatever its router calls it in the one line where it renders the link.
 */
export interface MenuLinkRenderProps {
  readonly href: string;
  readonly className: string;
  readonly role: 'menuitem';
  readonly tabIndex: 0 | -1;
  readonly children: ReactNode;
  readonly onClick: () => void;
  /**
   * The item's position among the menu's interactive entries, separators excluded. Roving focus
   * finds the active item by this rather than by a stored ref, so a render prop that drops it
   * loses arrow-key nav for that one item rather than the whole menu.
   */
  readonly 'data-menu-item-index': number;
}

/** Handed to the render-prop trigger. Spread directly onto whatever element the caller renders. */
export interface MenuTriggerRenderProps {
  readonly ref: RefObject<HTMLButtonElement | null>;
  readonly type: 'button';
  readonly 'aria-haspopup': 'menu';
  readonly 'aria-expanded': boolean;
  readonly 'aria-controls': string;
  readonly onClick: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  /** The menu's accessible name - what the panel is a menu *of*. */
  readonly label: string;
  readonly items: readonly MenuEntry[];
  /** Renders the trigger. Spread the argument onto a `<Button>` or a plain `<button>`. */
  readonly children: (trigger: MenuTriggerRenderProps) => ReactNode;
  /**
   * Renders one link item. Defaults to a plain `<a>`, correct for an external destination and
   * wrong inside the application - see `Nav.tsx`'s own note on this prop.
   */
  readonly renderLink?: (props: MenuLinkRenderProps) => ReactNode;
  /** Layout only - the panel's own position within its container, never a restyle of the frame. */
  readonly className?: string;
}

function defaultRenderLink(props: MenuLinkRenderProps): ReactNode {
  const { href, children, ...rest } = props;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

function isInteractive(entry: MenuEntry): entry is MenuAction | MenuLink {
  // A link carries no `disabled` field - a destination you cannot reach is a link that should not
  // be offered, not a link rendered inert - so only an action can take this branch's `disabled`.
  return (
    entry.kind !== 'separator' &&
    entry.kind !== 'content' &&
    !('disabled' in entry && entry.disabled)
  );
}

const itemClass = cn(
  'flex h-(--control-md) w-full items-center gap-2 px-3 text-left text-sm text-foreground',
  'pointer-coarse:h-(--control-lg) pointer-coarse:text-base',
  inkWashStates,
  focusRingInset,
  disabledState,
);

export function Menu(props: MenuProps): ReactNode {
  const { label, items, children, renderLink = defaultRenderLink, className } = props;

  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Bumped whenever a close should hand focus back to the trigger. A counter rather than a plain
  // boolean so two closes in a row - vanishingly unlikely, but free to handle - each still fire the
  // effect below, and a token rather than a direct ref read here: every path that can close the
  // menu is reachable from inside the rendered item list (a click handler built in `items.map`),
  // and reading `triggerRef.current` from there is a render-time ref access. Moving the read into
  // its own effect, keyed on this token, is what keeps it one.
  const [focusReturnToken, setFocusReturnToken] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Indices into `items` - not a separate numbering - so `activeIndex` always names one entry
  // directly, with no second translation table between "which item" and "which interactive item".
  const enabledIndices = items.reduce<number[]>(
    (acc, entry, index) => (isInteractive(entry) ? [...acc, index] : acc),
    [],
  );
  const firstEnabled = enabledIndices.length > 0 ? enabledIndices[0] : undefined;
  const lastEnabled =
    enabledIndices.length > 0 ? enabledIndices[enabledIndices.length - 1] : undefined;

  const closeSilently = (): void => {
    setOpen(false);
  };

  const closeAndReturnFocus = (): void => {
    setOpen(false);
    setFocusReturnToken((token) => token + 1);
  };

  useEffect(() => {
    if (focusReturnToken === 0) return;
    triggerRef.current?.focus();
  }, [focusReturnToken]);

  const openAt = (position: 'first' | 'last'): void => {
    const target = position === 'first' ? firstEnabled : lastEnabled;
    if (target !== undefined) setActiveIndex(target);
    setOpen(true);
  };

  const moveActive = (direction: 1 | -1): void => {
    if (enabledIndices.length === 0) return;
    const position = enabledIndices.indexOf(activeIndex);
    const nextPosition =
      (position === -1 ? 0 : position + direction + enabledIndices.length) % enabledIndices.length;
    const next = enabledIndices[nextPosition];
    if (next !== undefined) setActiveIndex(next);
  };

  const select = (entry: MenuAction | MenuLink): void => {
    if (entry.kind === 'link') {
      entry.onSelect?.();
    } else {
      entry.onSelect();
    }
    closeAndReturnFocus();
  };

  // Focus follows the active index while the menu is open, so arrow keys move real focus rather
  // than a visual-only highlight a screen reader has no way to hear. Found by the item's own
  // position marker rather than a stored ref, so a caller's `renderLink` only has to carry one
  // data attribute through to keep its item in the roving order.
  useEffect(() => {
    if (!open) return;
    const item = panelRef.current?.querySelector<HTMLElement>(
      `[data-menu-item-index="${String(activeIndex)}"]`,
    );
    item?.focus();
  }, [open, activeIndex]);

  // Outside pointerdown closes the menu. Attached only while open, same as every other disclosure
  // in this package (`Dialog.tsx`'s backdrop, `workspace-switcher.tsx` and `profile-menu.tsx`
  // before this replaced their own copies of the same effect).
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      // Not a return-focus close: the click already moved focus wherever the pointer landed.
      setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Placement: anchored below the trigger, flipped above and clamped 8px inside the visual
  // viewport - see the component doc comment for why `visualViewport` and not `window` alone.
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const margin = 8;

    const place = (): void => {
      const desktop =
        typeof matchMedia === 'function' ? matchMedia('(min-width: 640px)').matches : true;
      if (!desktop) {
        // Below `sm`, the panel is a bottom sheet laid out entirely in CSS (see `panelClass`
        // below); an inline position here would only have to be cleared again above.
        panel.style.removeProperty('top');
        panel.style.removeProperty('left');
        panel.style.removeProperty('transform');
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();

      // `minHeight` set to the panel's own measured height (plus the same margin) reproduces
      // this component's previous flip rule - not enough room below for the panel as rendered -
      // through the shared primitive rather than a second copy of it.
      const placement = placeFloatingMenu(
        { left: triggerRect.left, top: triggerRect.top, bottom: triggerRect.bottom },
        panelRect.width,
        readViewportBounds(),
        { minHeight: panelRect.height + margin },
      );

      panel.style.setProperty('left', `${String(placement.left)}px`);
      panel.style.setProperty(
        'top',
        `${String(placement.above ? placement.top - 4 : placement.top + 4)}px`,
      );
      panel.style.setProperty('transform', placement.above ? 'translateY(-100%)' : 'none');
    };

    place();
    const viewport = window.visualViewport;
    window.addEventListener('resize', place);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [open, items.length]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAt('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt('last');
    }
  };

  // Attached once, to the panel, rather than once per item: it is what lets Escape close the menu
  // from a `content` entry's own controls (the profile menu's appearance radios, the workspace
  // switcher's plain links) exactly as it does from a real item, without those entries having to
  // know this component's key model exists. Arrow keys, Home and End stay scoped to real items -
  // read off the target's own `role`, not off which handler fired - so they never fight a radio
  // group's native left/right cycling for the same keys.
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Stops here, at the panel, rather than reaching a document- or window-level Escape
      // handler outside it (a dialog this menu sits inside, `sidebar-drawer.tsx`'s own listener
      // on `window`) - see that component's note on the convention: the innermost open thing
      // wins, and it wins by stopping propagation at its own node rather than by racing to
      // attach its listener first.
      event.stopPropagation();
      closeAndReturnFocus();
      return;
    }

    if (event.key === 'Tab') {
      // Left alone: the browser still moves focus on, this only drops the panel from the tree
      // first so it does not sit open over whatever comes next.
      closeSilently();
      return;
    }

    if ((event.target as HTMLElement).getAttribute('role') !== 'menuitem') return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (firstEnabled !== undefined) setActiveIndex(firstEnabled);
        break;
      case 'End':
        event.preventDefault();
        if (lastEnabled !== undefined) setActiveIndex(lastEnabled);
        break;
      default:
        break;
    }
  };

  const panelClass = cn(
    blueprintFrame,
    'fixed z-30 flex flex-col overflow-y-auto bg-background py-1 shadow-md',
    // design-token-exempt: 220px is a minimum reading measure for a short label list, the same
    // category as `Dialog.tsx`'s 560px - not a step on any scale.
    'min-w-[220px] max-w-[calc(100vw-16px)]',
    // Below `sm` the panel drops the anchored position entirely and becomes a bottom sheet: full
    // width, safe-area padding, same device concession as `Dialog.tsx`'s `presentation="standard"`.
    'max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto! max-sm:left-0! max-sm:max-h-[70vh] max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none max-sm:pb-[max(var(--spacing)*1,env(safe-area-inset-bottom))]',
    className,
  );

  return (
    <>
      {children({
        ref: triggerRef,
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': panelId,
        onClick: () => {
          if (open) closeSilently();
          else openAt('first');
        },
        onKeyDown: onTriggerKeyDown,
      })}

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="menu"
          aria-label={label}
          // Not a tab stop of its own: focus lands on an item (or stays on the trigger), never on
          // the menu container itself. Still needed on the attribute for the same reason `Dialog`'s
          // own `tabIndex={-1}` is - a `role="menu"` this focusable-in-principle owes assistive
          // technology a stop in the focus order, even one it is never the one actually used.
          tabIndex={-1}
          className={panelClass}
          onKeyDown={onPanelKeyDown}
        >
          {items.map((entry, index) => {
            if (entry.kind === 'separator') {
              return (
                <div
                  key={`separator-${String(index)}`}
                  role="separator"
                  className="my-1 border-t border-divider"
                />
              );
            }

            if (entry.kind === 'content') {
              const node =
                typeof entry.content === 'function'
                  ? entry.content({ close: closeSilently })
                  : entry.content;
              return <Fragment key={entry.key ?? `content-${String(index)}`}>{node}</Fragment>;
            }

            const tone = entry.destructive === true ? 'font-semibold' : undefined;
            const tabIndex = index === activeIndex ? 0 : -1;
            const key = entry.key ?? entry.label;

            if (entry.kind === 'link') {
              return (
                <Fragment key={key}>
                  {renderLink({
                    href: entry.href,
                    role: 'menuitem',
                    tabIndex,
                    className: cn(itemClass, tone),
                    onClick: () => {
                      select(entry);
                    },
                    children: (
                      <>
                        {entry.icon ? <Icon icon={entry.icon} size="sm" /> : null}
                        {entry.label}
                      </>
                    ),
                    'data-menu-item-index': index,
                  })}
                </Fragment>
              );
            }

            return (
              <button
                key={key}
                type="button"
                role="menuitem"
                tabIndex={tabIndex}
                disabled={entry.disabled}
                data-menu-item-index={index}
                className={cn(itemClass, tone)}
                onClick={() => {
                  select(entry);
                }}
              >
                {entry.icon ? <Icon icon={entry.icon} size="sm" /> : null}
                {entry.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
