import { Columns3, LayoutGrid, LayoutList, CalendarDays, ChartGantt } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { BoardView } from './board-view';
import { CalendarView } from './calendar-view';
import type { PropertyDefinition, View } from './container-model';
import { CARD_SIZES, DEFAULT_CARD_SIZE, GalleryView, type CardSize } from './gallery-view';
import { ListView } from './list-view';
import { TimelineView } from './timeline-view';
import type { ContainerData } from './use-container';

/**
 * Every kind of view this build can draw, and everything it knows about each one.
 *
 * **Adding a view kind is one entry in this table.** It used to be four edits that could not be
 * type-checked against each other - the kind list, an icon record, the editor's dropdown with its
 * hand-written configuration block, and a dispatch switch whose `default` case silently caught
 * anything new and drew it as a list. A kind added to three of those four compiled and shipped
 * looking like a list.
 *
 * The backend has the matching table in `Nix.Core/Views/ViewDefinition.cs`. The two are deliberately
 * separate: the server decides what is *storable* (a board must name a property to group by) and
 * this decides what is *drawable*. They agree on the stored names and nothing else, which is why an
 * older build meeting a newer build's view says it cannot draw it rather than crashing.
 */

/**
 * What every renderer is handed.
 *
 * The three renderers were structurally similar and had no shared type, so nothing checked that a
 * fourth would fit. `view` is non-nullable here: the unconfigured case is not a kind and is handled
 * once, by the caller, rather than by every renderer accepting a null it mostly ignores.
 */
export interface ViewRendererProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

/**
 * One property a kind can be configured from, and which properties will serve.
 *
 * A list needs none - with no columns configured it falls back to the effective schema, and with no
 * schema at all it still has titles to show - which is why a kind's list of these may be empty
 * rather than every kind carrying a vacuous one.
 */
export interface ViewConfiguration {
  /** The field on the view that names the property. */
  readonly field: 'groupBy' | 'dateProperty' | 'coverProperty' | 'endDateProperty';

  readonly label: string;

  /** Said when the schema offers nothing this kind can use. */
  readonly emptyHint: string;

  /** Said when it does. */
  readonly hint: string;

  /**
   * What the "nothing chosen" option is called.
   *
   * **The copy itself, not a flag that picks between two spellings of it.** This began as
   * `optional?: boolean`, which was three states - true, false, absent - standing in for a
   * two-state decision, forced the editor to test `=== true`, and made a test assert the *absence
   * of a key* rather than a piece of wording. Holding the label removes the branch, removes the
   * defensiveness, and puts this kind's copy in the registry beside the rest of its copy.
   *
   * The distinction it carries: "Choose a property" for something the view is waiting on, "None"
   * for something the view is complete without. A gallery offered "Choose a property" would read as
   * unfinished, and somebody would go looking for what was broken.
   *
   * It says nothing about validation. The server decides what is storable and each renderer decides
   * what it can draw; a third opinion here could only disagree with one of them.
   */
  readonly emptyChoice: string;

  /** Which declared properties may be chosen. */
  readonly accepts: (property: PropertyDefinition) => boolean;

  /**
   * Fields that stop meaning anything when the chosen property changes.
   *
   * A board's column order belonged to the old property; carried across, it would filter the new
   * one down to values it does not have.
   */
  readonly clears?: Partial<View>;
}

/**
 * One closed-set choice a kind offers, and the tokens it may take.
 *
 * The sibling of {@link ViewConfiguration} for the fields that are not properties: a card size is
 * not a key into the schema, so a property `<Select>` filtered by `accepts` has nothing to offer
 * it. The set is closed and small - which is `<Segmented>`'s territory - and the server refuses a
 * token outside it, so the options here are the contract's words and not a suggestion.
 */
/**
 * Which tokens each choosable field may take, named by the renderer that draws them.
 *
 * This is the join that used to be missing. `value` and `fallback` were plain `string`, so the
 * editor's options and the gallery's classes were two lists nothing compared - a fourth size added
 * here compiled, shipped, and drew as medium. Keying the tokens off the field makes the descriptor
 * below refuse a word the renderer has no classes for.
 */
interface ChoiceTokens {
  readonly cardSize: CardSize;
}

type ChoiceField = keyof ChoiceTokens;

interface ViewChoiceOf<TField extends ChoiceField, TToken extends string> {
  /** The field on the view that stores the chosen token. */
  readonly field: TField;

  readonly label: string;

  /** Guidance under the control, said in terms of what changes on screen. */
  readonly hint: string;

  /** The tokens, in the order offered, each with the word a person sees. */
  readonly options: readonly { readonly value: TToken; readonly label: string }[];

  /**
   * The token a null field draws as, shown as current until somebody chooses.
   *
   * Null and this token render identically, so the control marking it current is the truth rather
   * than a claim about what is stored: choosing it explicitly changes nothing anybody can see.
   */
  readonly fallback: TToken;
}

export type ViewChoice = {
  [TField in ChoiceField]: ViewChoiceOf<TField, ChoiceTokens[TField]>;
}[ChoiceField];

export interface ViewKindDescriptor {
  /** The name this kind is stored and published under. */
  readonly kind: string;

  /** What a person sees in the switcher and the editor. */
  readonly label: string;

  readonly icon: LucideIcon;

  readonly render: (props: ViewRendererProps) => ReactNode;

  /**
   * Every property this kind can be configured from, in the order the editor should offer them.
   *
   * **An array from the start, not a single slot that grows one later.** This was `ViewConfiguration
   * | null`, which was true of the three kinds that existed and was a shape rather than a rule: the
   * table's whole stated purpose is that adding a kind is one entry, and a shape that forces a type
   * change on the next kind fails that purpose whether or not the kind that trips it has landed yet.
   *
   * **What this actually buys, stated honestly, because the overclaim is tempting.** It makes the
   * editor's configuration block per-*property* rather than per-*kind*, so a kind needing two
   * properties - the timeline, with a start and an end - costs no change here and no second copy of
   * that block. It does *not* make a kind that needs a brand-new field cheap, and the timeline is
   * the receipt: `endDateProperty` had to be threaded through the `field` union below, the Zod
   * schema, the view record and its two contracts, the stored-JSON reader and writer, the OpenAPI
   * document, the generated client and every fixture. That threading is the cost of the flat view
   * record, which `ViewDefinition.cs` justifies on its own terms; changing it is an ADR, not a
   * refactor.
   *
   * Empty for a list, which needs nothing configured to draw.
   */
  readonly configures: readonly ViewConfiguration[];

  /**
   * The closed-set choices this kind offers, in the order the editor should offer them.
   *
   * Empty for every kind whose look is not adjustable, which keeps "adding a kind is one entry"
   * true for this axis the same way `configures` keeps it true for properties.
   */
  readonly chooses: readonly ViewChoice[];
}

/**
 * The word a person sees for each card size.
 *
 * A `Record<CardSize, ...>` rather than a capitalisation of the stored token: the copy stays
 * written out, and a size added to `CARD_SIZES` fails to compile here until somebody says what it
 * is called. Deriving the label would have shipped a size named after its wire word instead.
 */
const CARD_SIZE_LABELS: Record<CardSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

export const VIEW_KINDS: readonly ViewKindDescriptor[] = [
  {
    kind: 'list',
    label: 'List',
    icon: LayoutList,
    render: (props) => <ListView {...props} />,
    configures: [],
    chooses: [],
  },
  {
    kind: 'board',
    label: 'Board',
    icon: Columns3,
    render: (props) => <BoardView {...props} />,
    configures: [
      {
        field: 'groupBy',
        label: 'Group by',
        emptyHint: 'There is no select property yet. Add one under Properties first.',
        hint: 'Only a select property can become columns.',
        emptyChoice: 'Choose a property',
        accepts: (property) => property.type === 'select',
        clears: { groupOrder: [] },
      },
    ],
    chooses: [],
  },
  {
    kind: 'calendar',
    label: 'Calendar',
    icon: CalendarDays,
    render: (props) => <CalendarView {...props} />,
    configures: [
      {
        field: 'dateProperty',
        label: 'Place by',
        emptyHint: 'There is no date property yet. Add one under Properties first.',
        hint: 'Items appear on the day this property names.',
        emptyChoice: 'Choose a property',
        // Both, because a calendar places by either. A date is an all-day thing that must not
        // shift for a reader in another zone; a timestamp is a moment that must.
        accepts: (property) => property.type === 'date' || property.type === 'timestamp',
      },
    ],
    chooses: [],
  },
  {
    kind: 'gallery',
    label: 'Gallery',
    icon: LayoutGrid,
    render: (props) => <GalleryView {...props} />,
    configures: [
      {
        field: 'coverProperty',
        label: 'Cover',
        // Both hints say the gallery works either way, because it does. A hint telling somebody to
        // go and add a property first would be describing a board.
        //
        // "Picture" rather than "image": that is what the Properties panel calls the type, and a
        // hint naming the wire word sends somebody looking for a choice that is not in the list.
        emptyHint:
          'There is no picture property yet. Add one under Properties to give these cards covers; without one they show titles.',
        // Not "cards whose items have no picture show their title" - every card shows its title,
        // always. What a card without a value shows *as well* is a frame saying so, and promising
        // otherwise would have somebody read a grid of "No cover" frames as a fault.
        hint: 'Each card shows this picture. A card whose item has none says so.',
        // Not "Choose a property": the gallery is complete without one.
        emptyChoice: 'None',
        accepts: (property) => property.type === 'image',
      },
    ],
    chooses: [
      {
        field: 'cardSize',
        label: 'Card size',
        // In terms of what changes on screen, not in terms of the stored token: columns and cover
        // room are the two things the size actually moves.
        hint: 'Small fits more cards in a row; large gives each cover more room.',
        // The renderer's own tuple, in its own order, rather than a second list of the same words:
        // the gallery is what has classes for these tokens, so it is what says which exist.
        options: CARD_SIZES.map((value) => ({ value, label: CARD_SIZE_LABELS[value] })),
        // What a gallery that has never been asked already draws as, so the control marking it
        // current is a description rather than a change waiting to be saved. The renderer resolves
        // null to this same constant.
        fallback: DEFAULT_CARD_SIZE,
      },
    ],
  },
  {
    kind: 'timeline',
    label: 'Timeline',
    icon: ChartGantt,
    render: (props) => <TimelineView {...props} />,
    // The first kind configured from two properties, which is what the array shape above exists
    // for. **No `clears` on either.** The start is the calendar's own `dateProperty` under the
    // calendar's own name, so switching a view between the two kinds has to carry it across
    // untouched; and the `week`/`month` grains the two share overlap on purpose, so clearing the
    // mode would throw away a choice that still means something.
    configures: [
      {
        field: 'dateProperty',
        // "Starts on" rather than the calendar's "Place by": a bar has two ends, and the pair has
        // to read as a pair in the form that sets them.
        label: 'Starts on',
        emptyHint: 'There is no date property yet. Add one under Properties first.',
        hint: 'Each bar begins on the day this property names.',
        // The view is genuinely waiting on this one: with no start there is no position, and the
        // timeline says so instead of drawing.
        emptyChoice: 'Choose a property',
        // Both, exactly as the calendar accepts both, and the server's requirement is the
        // calendar's verbatim. A date is an all-day thing that must not shift for a reader in
        // another zone; a timestamp is a moment that must.
        accepts: (property) => property.type === 'date' || property.type === 'timestamp',
      },
      {
        field: 'endDateProperty',
        label: 'Ends on',
        // Neither hint sends somebody to add a property first, because the view does not need one.
        emptyHint:
          'There is no second date property yet. Without one every item is drawn as a milestone on its start day.',
        hint: 'Each bar runs to the day this property names. An item without one is a milestone.',
        // Not "Choose a property": a timeline of milestones is complete, and calling it unfinished
        // would send somebody looking for what was broken.
        emptyChoice: 'None',
        accepts: (property) => property.type === 'date' || property.type === 'timestamp',
      },
    ],
    chooses: [],
  },
];

/**
 * What this build knows about a kind, or nothing at all.
 *
 * Returning null rather than a fallback is the whole fail-closed behaviour: a view written by a
 * newer build is reported as undrawable and left untouched, never quietly rendered as something
 * else. The `default` case this replaces did exactly that.
 */
export function findViewKind(kind: string): ViewKindDescriptor | null {
  return VIEW_KINDS.find((descriptor) => descriptor.kind === kind) ?? null;
}

/** Whether this build can draw a kind. */
export function isKnownViewKind(kind: string): boolean {
  return findViewKind(kind) !== null;
}
