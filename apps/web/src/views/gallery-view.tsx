import { Text, blueprintFrame, cn, focusRing } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { PartialNotice } from '../components/states/status-panels';
import { readPropertyText, type Item, type PropertyDefinition, type View } from './container-model';
import { CoverImage } from './cover-image';
import { CreateItemControl } from './create-item-control';
import { propertyTypeLabel } from './property-types';
import type { ContainerData } from './use-container';
import type { ViewRendererProps } from './view-kinds';
import { drawable, resolveViewChrome } from './view-chrome';
import { useViewState } from './view-state';

/**
 * The gallery: a container's children as a grid of cards, each optionally showing a cover picture.
 *
 * **The cover is not a requirement, and that is the decision this whole file is shaped around.** A
 * board with no grouping property has no columns, so it says so instead of drawing; a calendar with
 * no date property has nowhere to put anything. A gallery with no cover property is a grid of
 * titled cards - readable, useful, and what most galleries are on the day somebody makes one. So
 * this view is never undrawable: every path below ends in every item being on screen, and the four
 * things that can be wrong with a cover are said *on* or *above* the cards rather than instead of
 * them.
 *
 * **Four cases, four different sentences**, because collapsing any two of them tells somebody
 * something untrue:
 *
 *   - The view names no cover property. Cards are titles and properties, and there is no picture
 *     region at all. Not a grey box: a placeholder is a claim that something is loading.
 *   - A cover is configured and this item has no value. The frame says "No cover" in words. Not an
 *     empty box, which is indistinguishable from a failed load and from a white picture.
 *   - A cover is configured, the item has one, and it will not load. The frame says so, names the
 *     property to correct, and keeps the address readable. It must not fall back to the case above,
 *     which would claim the item has no cover when what it has is a broken one - and would send
 *     somebody to re-enter a URL that is already correct.
 *   - The cover property was deleted or retyped. Every card draws coverless and a notice above the
 *     grid names the property. The items are the container's; the property was somebody else's
 *     edit, and losing sight of the items over it would be the worst answer available.
 *
 * **Two more that the four-way telling misses, and both draw an empty box if you let them:**
 *
 *   - *Still loading.* Every cover below the fold is in this state on first paint, because they are
 *     lazy. An unframed `img` with nothing in it yet is precisely the empty box the second case
 *     forbids, so the picture region is **always** a drawn frame and the picture fills it - the
 *     geometry is identical in all states and never changes as covers resolve.
 *   - *A value that is not a fetchable address.* Retyping a text property to Picture does not
 *     revalidate what is already stored, so `cover: "draft notes"` is reachable without the server
 *     ever having seen it. Handed to an `img` it resolves against this origin, fetches the
 *     application shell, and reports as a failed load - a request fired at our own server, per
 *     card, for something nobody attempted to load. It gets its own sentence instead.
 */

/**
 * The sizes a card can be drawn at, in the order the editor offers them.
 *
 * **One tuple, and everything else on this axis is derived from it** - the union below, the two
 * class tables, the resolver's accepted tokens, and the editor's `<Segmented>` options through
 * `view-kinds.tsx`. The vocabulary used to be written out four times with nothing tying the copies
 * together, so a fourth size added to the editor's options compiled clean and drew as medium.
 * Adding one now is this line plus the two tables, and every other site follows or fails to
 * compile.
 *
 * The only copy left outside TypeScript is the server's `GalleryCardSizes`, which the OpenAPI
 * contract check covers.
 */
export const CARD_SIZES = ['small', 'medium', 'large'] as const;

/** The wire tokens; anything else draws as {@link DEFAULT_CARD_SIZE}. */
export type CardSize = (typeof CARD_SIZES)[number];

/**
 * What a gallery that has never been asked draws at.
 *
 * Named once because two places need the same answer for different reasons: this file resolves a
 * null or unrecognised token to it, and the editor marks it current so the control describes what
 * is on screen rather than proposing a change.
 */
export const DEFAULT_CARD_SIZE: CardSize = 'medium';

/**
 * The grid each size lays out, as one whole literal per size.
 *
 * Full class strings rather than assembled ones, because Tailwind only generates what it can read
 * in the source text - a computed `grid-cols-${n}` is a class that does not exist at runtime.
 * Medium is verbatim what this grid was before sizes existed, so a stored gallery that has never
 * been asked keeps looking exactly as it always has.
 */
const CARD_SIZE_GRID: Record<CardSize, string> = {
  small: 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6',
  medium: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  large: 'grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3',
};

/**
 * The shape of the picture region at each size.
 *
 * Part of the size, not left to the grid: a small card keeping a 16:9 cover would be a sliver of
 * letterbox nobody can read a picture in, so the denser the columns the squarer the frame. Medium
 * keeps `aspect-video`, which is what every cover drew at before sizes existed.
 */
const CARD_SIZE_COVER: Record<CardSize, string> = {
  small: 'aspect-square',
  medium: 'aspect-video',
  large: 'aspect-4/3',
};

/**
 * Which size to draw, given what the view stores.
 *
 * Null is the ordinary state - every gallery stored before the field existed - and an unrecognised
 * token is a newer server's word this build has no classes for. Both draw as medium, because a
 * fallback that keeps every card on screen at the size galleries have always been is honest, and
 * failing the render over a cosmetic token would not be.
 */
function resolveCardSize(stored: string | null): CardSize {
  // Read off the tuple rather than a hand-written literal check, so a size added there is
  // recognised here without a second edit - and so the resolver can never fall behind the classes.
  return CARD_SIZES.find((size) => size === stored) ?? DEFAULT_CARD_SIZE;
}

export function GalleryView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();

  const cover = resolveCover(container, view);
  const size = resolveCardSize(view.cardSize);

  const chrome = resolveViewChrome({
    container,
    viewState,
    subject: 'this gallery',
    // Always drawable, and this is the one line that says so. A gallery has cards whatever the
    // schema is doing; see the header. Note that Core never reports a gallery in `unrenderable`
    // either - the kind carries no requirement server-side - so there is no verdict to reconcile
    // with, unlike the board.
    drawable: drawable(cover),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as cards.',
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${countOf(total, 'item')}. The filters in the address are hiding ${total === 1 ? 'it' : 'all of them'}, so the gallery is empty by request rather than because there is nothing here.`,
    }),
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  const resolved = chrome.drawable;

  // The same rule the board's card faces use: the view's `columns` are the properties worth showing
  // under a title. The cover is not one of them - it is the picture - and neither is the title,
  // which the card already leads with.
  //
  // Read off the *view* rather than off the resolved cover, so a property that has been retyped
  // away from a picture stays excluded. It is text now, so listing it would be defensible and
  // would put a wall of raw URLs under the titles - directly against what the notice above the
  // grid is saying, which is that nothing has been lost. Somebody chose it as the cover, not as a
  // column, and undoing that choice for them is not this view's decision to make.
  const secondary = view.columns.filter((key) => key !== view.coverProperty && key !== 'title');
  const schema = container.schema?.properties ?? [];

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {chrome.notice}

      {/* Above the grid rather than repeated on every card. The property is gone once, not once per
          item, and a notice on forty cards would say one fact forty times. */}
      {resolved.kind === 'missing' || resolved.kind === 'wrongType' ? (
        <PartialNotice pending={describeLostCover(resolved)} />
      ) : null}

      {/* Not virtualized, and that is only safe because the grid is bounded: `useContainer` asks
          for one page and ignores the cursor, so this draws at most the server's page of children.
          A gallery cares about that bound more than the list does - every card here may pull a
          remote picture, and the browser decodes each at its own resolution rather than at the
          card's - so a goal that teaches the container to follow the cursor and append has to
          bring virtualization with it rather than after it. */}
      {/* `role="list"` is not redundant. Tailwind's preflight sets `list-style: none` on every
          `ul`, and WebKit drops the list and listitem roles when it sees that - so on Safari with
          VoiceOver this grid would stop announcing "list, 24 items" and become an undifferentiated
          run of controls. That announcement is the whole of what this view promises: every item is
          still here. jsdom does not reproduce the stripping, so the tests below cannot catch it and
          this attribute is what keeps the promise on the platform where it breaks.

          Named after the view, so a switcher tab and the region it opens agree on what they are. */}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles --
          Justification: the rule is right about the specification and wrong about the platform.
          The role is implicit until `list-style: none` removes it in WebKit, which preflight does
          to every `ul` in this application, so here it restores a role rather than repeating one. */}
      <ul role="list" aria-label={view.name} className={CARD_SIZE_GRID[size]}>
        {chrome.items.map((item) => (
          <GalleryCard
            key={item.id}
            item={item}
            cover={resolved}
            size={size}
            secondary={secondary}
            schema={schema}
            onOpen={onOpen}
          />
        ))}
      </ul>

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        className="mt-1 self-start"
      />
    </div>
  );
}

/**
 * What this gallery's cover column is, or why it has none - as data rather than as flags read in
 * four places.
 *
 * `none` and the two broken cases draw the same card, and are deliberately not the same value:
 * only the broken ones earn a notice, and "nobody asked for covers" must never produce one.
 */
type Cover =
  | { readonly kind: 'ready'; readonly property: PropertyDefinition }
  | { readonly kind: 'none' }
  | { readonly kind: 'missing'; readonly key: string }
  | { readonly kind: 'wrongType'; readonly property: PropertyDefinition };

function resolveCover(container: ContainerData, view: View): Cover {
  if (view.coverProperty === null || view.coverProperty.length === 0) {
    return { kind: 'none' };
  }

  const property = container.schema?.properties.find(
    (candidate) => candidate.key === view.coverProperty,
  );

  if (property === undefined) {
    // Told apart from `none` on purpose. Somebody configured covers and they have stopped
    // appearing; a silent fallback to titled cards would look like the gallery had never been
    // configured, and the person would configure it again.
    return { kind: 'missing', key: view.coverProperty };
  }

  return property.type === 'image' ? { kind: 'ready', property } : { kind: 'wrongType', property };
}

/** A lost cover, named. */
type LostCover = Extract<Cover, { kind: 'missing' } | { kind: 'wrongType' }>;

/**
 * What the notice says about a cover property that is gone.
 *
 * Both sentences end the same way and they have to: the sentence somebody needs is not "your
 * covers are missing" but "your items are not".
 */
function describeLostCover(cover: LostCover): string {
  const still = 'Every item is still here; the cards are showing their titles instead.';

  // "properties", not "fields": that is the word the schema editor's title and the view editor's
  // hint both use, and two names for one concept across two panels is one name too many.
  //
  // The type is named by its label and quoted rather than dropped into the sentence raw. The stored
  // token is not a word anybody has been shown - somebody who picked "Picture" from a list would
  // otherwise be told their property is now a "multi_select" - and quoting keeps the sentence
  // grammatical whatever the label turns out to be.
  return cover.kind === 'missing'
    ? `Covers came from "${cover.key}", which is no longer one of this item's properties. ${still}`
    : `Covers came from "${cover.property.label}", which is now "${propertyTypeLabel(cover.property.type)}" rather than a picture. ${still}`;
}

/** "1 item", "4 items" - said once here because three views had three spellings of it. */
function countOf(total: number, noun: string): string {
  return `${String(total)} ${total === 1 ? noun : `${noun}s`}`;
}

interface GalleryCardProps {
  readonly item: Item;
  readonly cover: Cover;
  readonly size: CardSize;
  readonly secondary: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly onOpen: (itemId: string) => void;
}

function GalleryCard(props: GalleryCardProps): ReactNode {
  const { item, cover, size, secondary, schema, onOpen } = props;

  // Absent values render as nothing rather than as an empty row: a card is a summary, and a column
  // of blank labels tells nobody anything.
  const fields = secondary.flatMap((key) => {
    const definition = schema.find((entry) => entry.key === key);
    const text = readPropertyText(item, key);
    return definition === undefined || text.length === 0 ? [] : [{ definition, text }];
  });

  return (
    // `blueprintFrame` composed directly rather than `<Blueprint className="bg-surface">`: that
    // component's `className` is documented as layout only, with its border, corners and
    // *transparency* being its contract, so passing a fill through it is the restyle the doc
    // forbids. `Card` in packages/ui composes the frame the same way for the same reason.
    //
    // `relative` is load-bearing - it is what the title button's stretched hit area is measured
    // against - and `shadow-sm` is the resting elevation every other card in the product has.
    <li className={cn(blueprintFrame, 'relative flex flex-col gap-2 bg-surface p-3 shadow-sm')}>
      {/* **The title comes first in the DOM and the picture is moved above it visually.** A screen
          reader reading in source order would otherwise meet "No cover" before it had been told
          which item that was about - the status arriving ahead of its subject. `order-first` puts
          the picture back on top for everyone reading with their eyes. */}
      {/* A real heading, so a card grid can be walked by heading rather than only by tabbing
          through every title in it. A gallery is the view where that matters most - it is a page of
          named things and nothing else - and a `span` styled to look like a heading gives a screen
          reader user no way through it. The control lives inside the heading so both the outline
          and the affordance survive. */}
      <h3>
        <button
          type="button"
          onClick={() => {
            onOpen(item.id);
          }}
          // The card is mostly picture, and in a gallery the picture *is* the affordance - it is
          // why somebody chose this view. A stretched pseudo-element makes the whole card clickable
          // while the accessible tree keeps exactly one control per card; a second click target on
          // the image would be two controls with one name.
          className={cn(
            'w-full text-left after:absolute after:inset-0 after:content-[""]',
            focusRing,
          )}
        >
          <Text variant="h5" as="span">
            {item.title || 'Untitled'}
          </Text>
        </button>
      </h3>

      {/* Nothing at all when no cover was asked for. A grey rectangle here would be a placeholder
          for a picture that was never coming, which reads as a load that never finished. */}
      {cover.kind === 'ready' ? (
        <div className="order-first">
          <CoverPane
            src={readPropertyText(item, cover.property.key)}
            label={cover.property.label}
            size={size}
          />
        </div>
      ) : null}

      {fields.length === 0 ? null : (
        <dl className="flex flex-col gap-0.5">
          {fields.map((field) => (
            <div key={field.definition.key} className="flex gap-2">
              <Text variant="caption" tone="muted" as="dt">
                {field.definition.label}
              </Text>
              <Text variant="caption" as="dd">
                {field.text}
              </Text>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** The card's picture region: the cover, or the words that say why there is not one. */
function CoverPane({
  src,
  label,
  size,
}: {
  readonly src: string;
  readonly label: string;
  readonly size: CardSize;
}): ReactNode {
  // **The state is the address that failed, not a flag plus a copy of the address.** Holding a
  // boolean would need a mirrored `src` beside it to know when to clear, which is a prop copied
  // into state by hand - the thing the state ladder exists to avoid - and it would need a
  // render-phase write to reconcile the two. Storing the URL makes the answer derived: a corrected
  // address simply is not the failed one, so it self-corrects with nothing to reconcile.
  //
  // In an effect this would render once showing a failure that belonged to the previous URL, so
  // somebody who fixed a typo would be told they had not.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;

  if (src.length === 0) {
    // In words, not as an empty box. An empty box is indistinguishable from a cover that failed to
    // load and from a picture that happens to be white.
    return (
      <CoverFrame size={size}>
        <Text variant="caption" tone="muted" as="span">
          No cover
        </Text>
      </CoverFrame>
    );
  }

  if (!isFetchableAddress(src)) {
    // **Its own state, and never handed to an `img`.** A schema retype does not revalidate values
    // already stored, so a property that was text yesterday can hold "draft notes" and be a picture
    // property today - the server's write-time scheme check never saw it. Given to an `img` that
    // resolves against this origin, fetches the application shell, fails to decode, and reports as
    // a broken cover: a request fired at our own server, per card, for something nobody ever
    // attempted to load, and the no-referrer reasoning quietly voided because it is same-origin.
    //
    // It is not "No cover" either - there is a value - so it says what is actually wrong.
    return (
      <CoverFrame size={size}>
        <Text variant="caption" tone="muted" as="span">
          This is not a picture address
        </Text>
        <CoverDetail>{src}</CoverDetail>
      </CoverFrame>
    );
  }

  if (failed) {
    // Never the "No cover" state. This item has a cover; it is the fetch that is broken, and
    // telling somebody the property is empty would send them to re-enter an address that is
    // already right. The property is named because that is where the correction is made, and the
    // address is shown because it is the only evidence on the card.
    return (
      <CoverFrame size={size}>
        <Text variant="caption" tone="muted" as="span">
          {`This cover could not be loaded. Check the address in ${label}.`}
        </Text>
        <CoverDetail>{src}</CoverDetail>
      </CoverFrame>
    );
  }

  // **Framed even while it is loading, which is the state the four-way telling forgets.** Covers
  // are lazy, so every card below the fold sits here on first paint; a bare `img` with nothing in
  // it yet is exactly the empty box the "No cover" case exists to avoid, and a grid half-framed and
  // half-hollow reads as a fault. The frame is a hairline rather than a fill, so it claims nothing
  // about progress - it just means the card never has a hole in it, and the geometry is identical
  // in every state so nothing reflows as pictures resolve.
  return (
    <CoverFrame size={size}>
      <CoverImage
        src={src}
        // Empty on purpose, and this is the accessible-name decision rather than an omission. The
        // cover carries nothing the card does not already say as text - the title is right beside
        // it, and it is what the picture is *of*. `alt={item.title}` would have a screen reader
        // announce the same words twice, once as a picture and once as the control. A decorative
        // duplicate of adjacent text is exactly what an empty alt is for.
        alt=""
        className="absolute inset-0 size-full object-cover"
        onError={() => {
          setFailedSrc(src);
        }}
      />
    </CoverFrame>
  );
}

/**
 * The address under a cover's refusal.
 *
 * Clamped, because a presigned or CDN address runs to hundreds of characters and `break-all` inside
 * a fixed-ratio box wraps it to a dozen lines that spill straight through the frame and collide with
 * the title. The full value stays reachable as the title attribute and, properly, in the property
 * panel - the card's job is to say which address it was, not to be the place it is read.
 */
function CoverDetail({ children }: { readonly children: string }): ReactNode {
  return (
    <Text
      variant="caption"
      as="span"
      tone="muted"
      title={children}
      className="line-clamp-2 break-all"
    >
      {children}
    </Text>
  );
}

/**
 * The picture-shaped space a cover occupies - holding the picture, or the words about it.
 *
 * One box for all four states, so a grid does not reflow as covers resolve and a card is never a
 * hole. `overflow-hidden` is what keeps a long address inside the hairline; `relative` is what the
 * picture fills.
 */
function CoverFrame({
  children,
  size,
}: {
  readonly children: ReactNode;
  readonly size: CardSize;
}): ReactNode {
  return (
    <div
      className={cn(
        blueprintFrame,
        CARD_SIZE_COVER[size],
        'relative flex w-full flex-col items-center justify-center gap-1 overflow-hidden p-3 text-center',
      )}
    >
      {children}
    </div>
  );
}

/**
 * Whether a stored value is something a browser may be asked to fetch.
 *
 * The same rule the server applies on write, applied again at the render because the server's copy
 * does not cover values that predate the declaration: a retype changes what a property means
 * without revalidating what is already in it. Two checks rather than one, deliberately - this is
 * the layer that is true regardless of the order somebody edited things in.
 */
function isFetchableAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    // Not absolute, so not something to resolve against this origin and hope.
    return false;
  }
}
