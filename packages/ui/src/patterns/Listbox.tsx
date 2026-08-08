import { useId, useState, type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';

import { cn } from '../lib/cn';
import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';

/**
 * <Listbox> - a filtered list of choices, driven from a text field that keeps the focus.
 *
 * The shape behind three different surfaces: the block inserter opened with `/`, the item picker
 * opened with `[[`, and the command palette. All three are the same object - type into a field,
 * move a highlight with the arrow keys, commit with Enter - and all three had been about to grow
 * their own copy of it.
 *
 * **Focus does not move into the list, and that is the whole reason this exists.** The obvious
 * implementation makes each option a `<button>` and lets Tab reach it, which puts a listbox's
 * options in the tab order, breaks type-ahead the moment focus leaves the field, and announces
 * every option as a button. The correct pattern keeps focus on the input and moves
 * `aria-activedescendant` instead, so a screen reader reads the highlighted option while the
 * person is still typing into the field they started in. That is fiddly enough - stable ids per
 * option, a controlled index, an `aria-controls` that has to resolve - that it is worth owning
 * once.
 *
 * **Escape is deliberately not handled here.** Which layer closes is the caller's to decide, and
 * the convention in `apps/web` is that the innermost open thing wins and calls `stopPropagation`.
 * A listbox that swallowed Escape would close the picker inside a dialog and leave the dialog open,
 * or worse, close both.
 */

/**
 * As much of a keyboard event as the key model reads.
 *
 * Structural rather than React's `KeyboardEvent`, because not every caller has one. The reference
 * picker keeps focus in the editor - the query it filters on lives in the document, so a field of
 * its own would swallow the typing - and hands this a DOM event off `editor.view.dom`. Both shapes
 * satisfy it, and neither has to be converted.
 */
export interface ListboxKeyEvent {
  readonly key: string;
  preventDefault: () => void;
}

/** One choice. */
export interface ListboxOption {
  /** Stable across renders and unique within the list; what the caller gets back on selection. */
  readonly id: string;

  readonly label: string;

  /** A few words of context, shown after the label and never in place of it. */
  readonly hint?: string;

  readonly icon?: LucideIcon;

  /**
   * A heading this option sits under.
   *
   * A heading is drawn whenever the group changes from the previous option, so the caller orders
   * the list and the grouping follows - rather than passing nested arrays, which would make "the
   * fourth option overall" something every keyboard handler has to compute.
   */
  readonly group?: string;
}

/** The state and the wiring one listbox needs. Returned by {@link useListbox}. */
export interface ListboxController {
  /** The listbox element's id, for the input's `aria-controls`. */
  readonly id: string;

  /** Which option the highlight is on. Always in range, including after the list shrinks. */
  readonly activeIndex: number;

  /** The highlighted option's element id, for the input's `aria-activedescendant`. */
  readonly activeOptionId: string | undefined;

  /** Moves the highlight. For pointer movement over the list. */
  readonly setActiveIndex: (index: number) => void;

  /** Commits an option, as Enter and a click both do. */
  readonly select: (index: number) => void;

  /**
   * Arrow keys, Home, End and Enter, for whatever holds the focus.
   *
   * Not Escape, and not Tab: see the note on the module. Every other key falls through untouched,
   * so the thing it is attached to still behaves like itself.
   */
  readonly onKeyDown: (event: ListboxKeyEvent) => void;
}

/**
 * Owns a listbox's highlight and the keys that move it.
 *
 * @param options The current, already-filtered list.
 * @param onSelect Called with the committed option.
 * @returns The controller to give the input and the {@link Listbox}.
 */
export function useListbox(
  options: readonly ListboxOption[],
  onSelect: (option: ListboxOption, index: number) => void,
): ListboxController {
  const id = useId();
  const [storedIndex, setStoredIndex] = useState(0);

  // Clamped on the way out rather than corrected in an effect. The list changes on every
  // keystroke, so an effect that reset the index would leave one render where the highlight points
  // past the end - and that render is the one the person sees while they are typing.
  const activeIndex = storedIndex < options.length ? storedIndex : 0;

  function select(index: number): void {
    const option = options[index];
    if (option !== undefined) {
      onSelect(option, index);
    }
  }

  function onKeyDown(event: ListboxKeyEvent): void {
    if (options.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        // Wrapping, because a list you filter is short and a person holding the key down expects
        // to come back round rather than stick at the bottom.
        setStoredIndex(activeIndex === options.length - 1 ? 0 : activeIndex + 1);
        break;

      case 'ArrowUp':
        event.preventDefault();
        setStoredIndex(activeIndex === 0 ? options.length - 1 : activeIndex - 1);
        break;

      case 'Home':
        event.preventDefault();
        setStoredIndex(0);
        break;

      case 'End':
        event.preventDefault();
        setStoredIndex(options.length - 1);
        break;

      case 'Enter':
        event.preventDefault();
        select(activeIndex);
        break;

      default:
        break;
    }
  }

  return {
    id,
    activeIndex,
    activeOptionId: options.length === 0 ? undefined : optionElementId(id, activeIndex),
    setActiveIndex: setStoredIndex,
    select,
    onKeyDown,
  };
}

export interface ListboxProps {
  /** What the list as a whole holds. Becomes its accessible name. */
  readonly label: string;

  readonly options: readonly ListboxOption[];

  readonly controller: ListboxController;

  /** What to say when nothing matches. A sentence, not a shrug. */
  readonly emptyMessage: string;

  /** Layout only. */
  readonly className?: string;
}

export function Listbox(props: ListboxProps): ReactNode {
  const { label, options, controller, emptyMessage, className } = props;

  return (
    <div className={cn('flex flex-col', className)}>
      {/*
        Rendered even when empty, so the input's `aria-controls` always resolves to something. An
        id that points at nothing is worse than an empty list: assistive technology reports the
        relationship as broken rather than as "no results".
      */}
      <div
        id={controller.id}
        role="listbox"
        aria-label={label}
        className={cn(options.length === 0 && 'hidden')}
      >
        {options.map((option, index) => {
          const active = index === controller.activeIndex;
          const heading = option.group !== undefined && option.group !== options[index - 1]?.group;

          return (
            <div key={option.id}>
              {heading ? (
                <Text
                  as="p"
                  variant="caption"
                  tone="muted"
                  className="px-3 pt-3 pb-1 uppercase tracking-wide"
                >
                  {option.group}
                </Text>
              ) : null}

              {/*
                An option, not a button. Focus stays in the field the person is typing into and the
                highlight travels by `aria-activedescendant`; making these focusable would put them
                in the tab order and announce each one as a button.

                `onMouseDown` with `preventDefault` rather than `onClick`: a click first moves focus
                away from the input, and in the editor's picker that closes the whole thing before
                the selection is read. Committing on press keeps the field focused throughout.
              */}
              {/*
                eslint-disable-next-line jsx-a11y/interactive-supports-focus --
                Justification: an option in this pattern must NOT be focusable. Focus stays on the
                caller's text field and the highlight travels by `aria-activedescendant`, which is
                the composite-widget pattern this component exists to provide. The rule is checking
                for the other mistake - an interactive role on something a keyboard cannot reach at
                all - and cannot see that the field carries the keyboard model on its behalf.
              */}
              <div
                id={optionElementId(controller.id, index)}
                role="option"
                aria-selected={active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  controller.select(index);
                }}
                onMouseMove={() => {
                  if (!active) {
                    controller.setActiveIndex(index);
                  }
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                  active && 'bg-accent/10',
                )}
              >
                {option.icon === undefined ? null : (
                  <Icon icon={option.icon} size="sm" className="shrink-0 text-muted" />
                )}

                <span className="min-w-0 flex-1 truncate">{option.label}</span>

                {option.hint === undefined ? null : (
                  <Text as="span" variant="caption" tone="muted" className="shrink-0">
                    {option.hint}
                  </Text>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {options.length === 0 ? (
        // `role="status"` so the sentence is announced when the filtering produces it, rather than
        // leaving somebody typing into a field whose list silently emptied. On a wrapper rather
        // than on the text: <Text> takes a variant and a tone and deliberately not arbitrary
        // attributes, and widening a primitive every layer above it shares is a poor trade for one
        // element saved.
        <div role="status">
          <Text as="p" variant="body" tone="muted" className="px-3 py-2">
            {emptyMessage}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The DOM id of one option.
 *
 * Derived from the listbox's own id and the option's position rather than from the option's
 * identifier, because an identifier may be a title, a path or anything else a person typed, and
 * `aria-activedescendant` needs something that is always a valid id.
 */
function optionElementId(listboxId: string, index: number): string {
  return `${listboxId}-option-${String(index)}`;
}
