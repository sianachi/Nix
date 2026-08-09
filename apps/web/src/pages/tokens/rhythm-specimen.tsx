import type { ReactElement } from 'react';

import { Blueprint, Card, Text, blueprintFrame, cn } from '@nix/ui';

/**
 * The rhythm specimen: the scale applied, not the scale itself.
 *
 * `SpacingSpecimen` (`scale-specimen.tsx`) proves the token reaches the compiled CSS - a set of
 * bars, each one a multiple of `--spacing`. It cannot show what U13's audit actually found wrong,
 * because every bar in it is correct by construction: nothing there can disagree with anything
 * else. The owner report that opened U13 was never "a bar is the wrong width" - it was "this
 * card's padding and that visually identical card's padding are two different steps", which is a
 * relationship between two places, not a fact about one value. A specimen of the scale cannot
 * show a relationship; only a composition can.
 *
 * So this is compositions, not bars - three relationships the audit named by name, each one
 * pulled from a real surface with its spacing classes unchanged:
 *
 *   - **Containment.** A card's own padding versus the padding of a panel grouped inside it.
 *     `<Card>` is `p-6`/`gap-4`; a grouped sub-panel - the board's column, the calendar's
 *     unscheduled tray, the schema and view editors' draft rows - is `border-divider p-3`/`gap-2`.
 *     The rule is not "the outer step must be looser than the inner one" - the board's own column
 *     is `p-3` around cards that are themselves `p-3` - it is that a frame's inset has to exceed
 *     the internal gap of whatever it frames. `p-3` (10.2px) around a `gap-2` (6.8px) stack reads
 *     as one group holding several things; equal or reversed, the frame stops reading as a frame.
 *   - **Row rhythm.** The same per-row padding repeated down a list, which is what makes a list
 *     read as one object with many rows rather than as one row repeated by accident. `Table`'s own
 *     `px-3 py-2` cell padding, shown as plain rows rather than inside a table element, since the
 *     rhythm is the point rather than the semantics.
 *   - **Chrome-to-content alignment.** The item header and the view switcher below it share one
 *     left edge (`px-8`, `ItemHeader` and `NoteEditor`'s document body in `EditorPage`), which is
 *     what the view switcher's own `px-4` broke before this goal corrected it. Two stacked rows at
 *     two different insets read as misaligned even when neither one is wrong on its own; only
 *     looking at them together shows it.
 *
 *     **This was true of the header and the document body only, until it wasn't.** A view's own
 *     content - the board, the gallery, the list, the calendar, the timeline - carries no
 *     horizontal padding of its own at all (`board-view.tsx`, `gallery-view.tsx` and the rest all
 *     open their root wrapper with no `px-*`), so switching the switcher's own inset from `px-4` to
 *     `px-8` widened its mismatch with *that* content from four steps to eight. That gap - what a
 *     view's own edge gutter should be - is now closed at `ContainerView` (`container-view.tsx`),
 *     the one place every view's render output passes through: it wraps that output in `px-8`
 *     rather than repeating the class in each of the five view files, which is what let the two
 *     insets drift apart the first time.
 *
 * A reviewer comparing a new screen against this has something to hold it next to. A reviewer
 * comparing it against `SpacingSpecimen` only learns that `p-2` and `p-3` both exist.
 */

function ContainmentDemo(): ReactElement {
  return (
    // `blueprintFrame` composed directly, not `<Blueprint className="bg-surface">`: the component's
    // own contract is that its className is layout only, and a fill is a restyle of the frame -
    // `Card.tsx` and `gallery-view.tsx`'s card both reach for the constant directly for the same
    // reason. `shadow-sm` alongside it for the same reason `Card` carries one: this is standing in
    // for `<Card>`'s own frame, and a card missing its resting elevation is not the card being shown.
    <div className={cn(blueprintFrame, 'flex flex-col gap-4 bg-surface p-6 shadow-sm')}>
      <Text tone="muted" variant="bodySmall">
        Card padding, p-6 / gap-4
      </Text>

      {/* The exact classes board-view.tsx's column panel, calendar-view.tsx's unscheduled tray and
          the schema and view editors' draft rows all share: a bordered group at p-3, gap-2. */}
      <div className="flex flex-col gap-2 border border-divider p-3">
        <Text variant="bodySmall" tone="muted">
          Grouped panel, p-3 / gap-2
        </Text>
        <Text as="p">
          This frame's own p-3 inset (10.2px) exceeds the gap-2 (6.8px) between the things inside it
          - that gap is what makes it read as one group, not that its padding differs from the
          card's.
        </Text>
      </div>
    </div>
  );
}

const ROW_ITEMS: readonly { readonly id: string; readonly label: string; readonly meta: string }[] =
  [
    { id: 'a', label: 'Design review', meta: 'Due Friday' },
    { id: 'b', label: 'Migration plan', meta: 'Due Monday' },
    { id: 'c', label: 'Spacing pass', meta: 'In progress' },
  ];

function RowRhythmDemo(): ReactElement {
  return (
    <Blueprint className="overflow-hidden">
      <ul className="flex flex-col">
        {ROW_ITEMS.map((item, index) => (
          <li
            key={item.id}
            className={cn(
              // The same px-3 py-2 packages/ui's <Table> names `cellPadding` - copied rather than
              // imported, since the point here is a plain row, not a table cell.
              'flex items-center justify-between gap-3 px-3 py-2',
              index === ROW_ITEMS.length - 1 ? '' : 'border-b border-divider',
            )}
          >
            <Text as="span">{item.label}</Text>
            <Text as="span" tone="muted" variant="bodySmall">
              {item.meta}
            </Text>
          </li>
        ))}
      </ul>
    </Blueprint>
  );
}

function ChromeAlignmentDemo(): ReactElement {
  return (
    // blueprintFrame composed directly rather than a filled <Blueprint>, for the same reason
    // ContainmentDemo above does - the component's className is layout only.
    <div className={cn(blueprintFrame, 'flex flex-col overflow-hidden bg-background')}>
      {/* ItemHeader's own padding, verbatim (editor-page.tsx). */}
      <div className="px-8 pb-3 pt-4">
        <Text variant="h5" as="p">
          Untitled note
        </Text>
      </div>

      {/* A plain row, not a `<nav>`: this illustrates the switcher's alignment, it does not
          navigate anything, so a landmark role would be a lie about what it is. Not `aria-hidden`
          either - the paragraph below names these tabs by their visible text, and hiding a
          `<span>` that the surrounding prose refers to leaves a screen-reader user pointed at
          content they were never given. */}
      <div className="flex items-center gap-1 border-y border-divider px-8 py-1.5">
        {/* text-primitive-exempt: the switcher's own classes, verbatim (`view-switcher.tsx`).
            A specimen that redrew the thing it is quoting through `<Text>` would stop being
            evidence about the real surface and start being evidence about the specimen. */}
        <span className="border border-divider px-2 py-1 text-xs">Document</span>
        <span className="border border-transparent px-2 py-1 text-xs text-muted">Board</span>
      </div>

      {/* NoteEditor's own document-body padding, verbatim (note-editor.tsx). */}
      <div className="px-8 py-6">
        <Text tone="muted">
          The title, the tabs and this paragraph all start at the same left edge, px-8. The view
          switcher used to open at px-4, four steps inside where the title and the document body
          both start.
        </Text>
      </div>
    </div>
  );
}

export function RhythmSpecimen(): ReactElement {
  return (
    <Card kicker="Patterns" title="Rhythm">
      <Text tone="muted">
        Every value below is a token-backed utility class already in use somewhere in the app. What
        this specimen adds is the comparison a bar chart of the scale cannot make: two of these
        values sitting next to each other, so a step chosen wrongly is something a reviewer can
        actually see rather than something they would have to already know to check for.
      </Text>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Text variant="kicker">Containment</Text>
          <ContainmentDemo />
        </div>

        <div className="flex flex-col gap-2">
          <Text variant="kicker">Row rhythm</Text>
          <RowRhythmDemo />
        </div>

        <div className="flex flex-col gap-2">
          <Text variant="kicker">Chrome-to-content alignment</Text>
          <ChromeAlignmentDemo />
          <Text tone="muted" variant="bodySmall">
            The header and the document body share this left edge directly. A view's own content -
            board, gallery, list, calendar, timeline - still carries no horizontal padding of its
            own; it shares the edge instead through the `px-8` wrapper in `ContainerView`, see the
            note above this component.
          </Text>
        </div>
      </div>
    </Card>
  );
}
