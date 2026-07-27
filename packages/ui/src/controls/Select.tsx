import { type ComponentPropsWithRef, type ReactNode } from 'react';

import { blueprintFrame } from '../primitives/Blueprint';
import { disabledState, focusRing } from '../primitives/interaction';
import { cn } from '../lib/cn';

/**
 * <Select> - one choice from a list, on the platform's own `<select>`.
 *
 * **A native element rather than a built one.** A custom listbox owes typeahead, arrow keys, page
 * up and down, home and end, an escape that restores the previous value, a popover that flips when
 * it would fall off the screen, and correct behaviour under a screen reader in every combination of
 * those. The platform has all of it, and on a phone it opens the system picker, which is the
 * control people already know. What is lost is the ability to put an icon beside an option, which
 * nothing here needs.
 *
 * It exists because four places had hand-written one: the schema editor twice, the view editor, and
 * the property panel - each with its own copy of the same class string, and each free to drift.
 *
 * The frame, height, focus ring and disabled treatment are `<Input>`'s, deliberately: a select and
 * a text field standing next to each other in a form that did not agree on their height is the
 * thing this package exists to prevent.
 */

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'style' | 'size'> {
  /** The options. Rendered as children so a caller can group or disable them. */
  readonly children: ReactNode;
}

export function Select({ children, className, ...rest }: SelectProps): ReactNode {
  return (
    <select
      {...rest}
      className={cn(
        blueprintFrame,
        'w-full border-divider bg-background px-3',
        'h-(--control-md) font-body text-md text-foreground',
        focusRing,
        disabledState,
        'aria-invalid:border-foreground',
        className,
      )}
    >
      {children}
    </select>
  );
}
