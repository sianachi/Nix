import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { isEditableTarget } from '../primitives/interaction';
import { MenuPanel, type MenuEntry, type MenuLinkRenderProps, type MenuPanelAnchor } from './Menu';

/**
 * <ContextMenu> - the menu a secondary click opens, where the pointer is.
 *
 * A right-click that shows the browser's own Back / Reload / Inspect menu over a page row is the
 * single most reliable tell that an application is a web page. This replaces it on the surfaces
 * that have actions of their own, with the same panel `<Menu>` opens - the same keyboard model,
 * roving focus, outside-click dismissal, viewport clamping and bottom sheet below `sm` - so the
 * two never drift apart.
 *
 * **Every way a platform asks for one.** A secondary click and a trackpad two-finger tap arrive as
 * `contextmenu`. The keyboard's Menu key and Shift+F10 are handled as keys on the target itself -
 * macOS raises no `contextmenu` for either - and anchor to the element rather than to a pointer.
 * A touch long-press raises `contextmenu` on Android but not on iOS, so a held touch that has not
 * moved opens the menu here too, and the tap that ends it is swallowed so it does not also
 * activate the row. A press that turns into a drag is the platform's, and cancels the menu.
 *
 * **What it leaves alone.** Text fields and editable content keep the browser's menu - that is
 * where spelling suggestions, paste and autofill live - and so does a right-click on text the
 * person has selected, where the browser's menu is how they copy it. A target with no entries
 * also keeps the browser's menu rather than opening an empty panel.
 *
 * **Focus.** Opening moves focus into the menu, as `<Menu>` does. Closing with a choice or Escape
 * returns it to whatever held it before - if that still exists, since a choice such as Delete or
 * Close can remove the very row it was made on.
 */

/**
 * Spread onto the element the menu belongs to. Only a marker attribute: the gestures are listened
 * for on the element itself, found by the marker once it has mounted, so the caller's own
 * handlers and refs stay the caller's.
 */
export interface ContextMenuTargetProps {
  readonly 'data-context-menu': string;
}

export interface ContextMenuProps {
  /** The menu's accessible name - what the panel is a menu *of*. */
  readonly label: string;
  /**
   * The entries, or a function building them when the menu opens - for a target whose actions
   * depend on state that should be read at that moment rather than on every render.
   */
  readonly items: readonly MenuEntry[] | (() => readonly MenuEntry[]);
  /**
   * Renders the target - the same element for the life of this component. Spread the argument
   * onto it.
   */
  readonly children: (target: ContextMenuTargetProps) => ReactNode;
  readonly renderLink?: (props: MenuLinkRenderProps) => ReactNode;
  /** Layout only - the panel's own position, never a restyle of the frame. */
  readonly className?: string;
}

/** How long a touch must be held, still, before it counts as a request for the menu. */
export const LONG_PRESS_MS = 500;
/** How far a held touch may drift, in CSS pixels, and still be a press rather than a scroll. */
const LONG_PRESS_SLOP = 10;

/** Whether the person has text selected inside the target - theirs to copy with the browser. */
function hasSelectionWithin(element: HTMLElement): boolean {
  const selection = globalThis.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return element.contains(selection.getRangeAt(0).commonAncestorContainer);
}

interface OpenMenu {
  readonly anchor: MenuPanelAnchor;
  readonly items: readonly MenuEntry[];
  /** What held focus when the menu opened, to hand it back to. */
  readonly returnFocus: HTMLElement | null;
}

export function ContextMenu(props: ContextMenuProps): ReactNode {
  const { label, items, children, renderLink, className } = props;
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const marker = useId();
  // Read by the listeners below, which are attached once rather than per render.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  // Found by its marker rather than held in a ref or in state: state rendered every row a second
  // time as it mounted, which a long table paid for in full.
  useEffect(() => {
    const element = document.querySelector<HTMLElement>(
      `[data-context-menu="${CSS.escape(marker)}"]`,
    );
    if (element === null) return;
    let press: {
      readonly timer: ReturnType<typeof setTimeout>;
      readonly x: number;
      readonly y: number;
    } | null = null;
    let swallowClick = false;
    let openedByPress = false;

    const show = (anchor: MenuPanelAnchor): boolean => {
      const current = itemsRef.current;
      const entries = typeof current === 'function' ? current() : current;
      if (entries.length === 0) return false;
      const active = document.activeElement;
      setOpen({
        anchor,
        items: entries,
        returnFocus: active instanceof HTMLElement ? active : null,
      });
      return true;
    };
    const elementAnchor = (): MenuPanelAnchor => {
      const focused = document.activeElement;
      const rect = (
        focused instanceof HTMLElement && element.contains(focused) ? focused : element
      ).getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom };
    };
    const cancelPress = (): void => {
      if (press) clearTimeout(press.timer);
      press = null;
    };

    const onContextMenu = (event: MouseEvent): void => {
      if (isEditableTarget(event.target) || hasSelectionWithin(element)) return;
      cancelPress();
      // The press that already opened this menu is still being held; Android now asks again.
      if (openedByPress) {
        event.preventDefault();
        return;
      }
      // A keyboard-raised menu (Windows sends one after Menu or Shift+F10) has no pointer position.
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const anchor = keyboard
        ? elementAnchor()
        : { left: event.clientX, top: event.clientY, bottom: event.clientY };
      if (show(anchor)) {
        event.preventDefault();
        // A nested target (a row inside a list that has its own menu) answers for itself.
        event.stopPropagation();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const asks = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
      if (!asks || event.defaultPrevented || isEditableTarget(event.target)) return;
      if (show(elementAnchor())) {
        // Also stops the browser raising its own `contextmenu` for the same key.
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      swallowClick = false;
      openedByPress = false;
      if (event.pointerType !== 'touch' || isEditableTarget(event.target)) return;
      cancelPress();
      const { clientX: x, clientY: y } = event;
      press = {
        x,
        y,
        timer: setTimeout(() => {
          press = null;
          if (show({ left: x, top: y, bottom: y })) {
            swallowClick = true;
            openedByPress = true;
          }
        }, LONG_PRESS_MS),
      };
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP)
        cancelPress();
    };
    // Captured on the target, so the tap that ends a long-press never reaches the row's own click
    // handler - React dispatches those from the root, after this has stopped the event.
    const onClick = (event: MouseEvent): void => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener('contextmenu', onContextMenu);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', cancelPress);
    element.addEventListener('pointercancel', cancelPress);
    // A long press that becomes a drag belongs to the platform's drag, not to this menu.
    element.addEventListener('dragstart', cancelPress);
    element.addEventListener('click', onClick, { capture: true });
    return () => {
      cancelPress();
      element.removeEventListener('contextmenu', onContextMenu);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', cancelPress);
      element.removeEventListener('pointercancel', cancelPress);
      element.removeEventListener('dragstart', cancelPress);
      element.removeEventListener('click', onClick, { capture: true });
    };
  }, [marker]);

  return (
    <>
      {children({ 'data-context-menu': marker })}
      {/* Portalled: the target may sit in a structure that may own nothing but its own rows - a
          tablist, a tree, a grid - and a menu is none of those. The panel is fixed-positioned,
          so where it lives in the DOM changes nothing about where it appears. */}
      {open
        ? createPortal(
            <MenuPanel
              label={label}
              items={open.items}
              initial="first"
              tabOrigin={open.returnFocus}
              renderLink={renderLink}
              className={className}
              anchor={() => open.anchor}
              onClose={(restore) => {
                setOpen(null);
                if (!restore) return;
                const target = open.returnFocus;
                // After the choice has run: it may have removed or moved the element focus
                // came from, and focus sent to a detached node lands on nothing.
                requestAnimationFrame(() => {
                  if (target?.isConnected === true) target.focus();
                });
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
