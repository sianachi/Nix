import { Button } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../components/states/status-panels';
import { applyFilters, sortItems, type Item } from './container-model';
import type { ContainerData } from './use-container';
import type { ViewStateControl } from './view-state';

/**
 * The five things every view has to say before it can say anything about items.
 *
 * Loading, could-not-be-read, cannot-be-drawn, genuinely-empty and hidden-by-filters are five
 * different facts, and each of the three views used to answer all five in its own words, in its own
 * order, with its own local panel shapes. Four copies of one decision is four chances for a view to
 * quietly drop a branch - and the branch a view drops is always the same one, because "the filters
 * are hiding everything" is the only one of the five that never happens while you are building it.
 *
 * **A function, not a component.** What comes back is a node to render or the items to draw, and
 * nothing wraps the caller. A component here would put a landmark of its own inside every view, and
 * the board asserts its region inventory exactly - shared chrome must be invisible in the accessible
 * tree, not merely tidy in the source.
 *
 * **The words stay with the view; only the branching moves.** A board that cannot be drawn and a
 * calendar that cannot be drawn are wrong in different ways and say so in different sentences. This
 * decides *which* of the five holds; the caller says what that means for it.
 *
 * **The drawable payload rides along.** A view usually has one thing it must resolve before it can
 * draw - the board's grouping property, the calendar's date property - and that resolution is also
 * what decides the cannot-be-drawn branch. Handing it back through the result is what lets the
 * caller use it without re-checking something this function has already proved, and without an
 * unreachable branch to satisfy the compiler.
 *
 * Not built on `AsyncSection`: that consumes an `AsyncStatus<T>` no view produces, and adopting it
 * here is more ceremony than the branch it replaces. It is, however, the seam paginated containers
 * should converge on, at which point this function is what gets rewritten rather than every view.
 */

/** A state that has a headline and an explanation - which is all of them worth drawing a panel for. */
export interface ViewChromeMessage {
  readonly title: string;
  readonly detail: string;
}

/**
 * What a view needs resolved before it can draw, or why it cannot be drawn.
 *
 * `undrawable` is a state about the *view's configuration*, not about the data: the items are all
 * still there, and every one of these messages says so. That is why it is reported as an error
 * panel rather than as an empty one.
 */
export type Drawable<TValue> =
  | { readonly kind: 'drawable'; readonly value: TValue }
  | ({ readonly kind: 'undrawable' } & ViewChromeMessage);

export function drawable<TValue>(value: TValue): Drawable<TValue> {
  return { kind: 'drawable', value };
}

export function undrawable<TValue>(message: ViewChromeMessage): Drawable<TValue> {
  return { kind: 'undrawable', ...message };
}

/**
 * Either the chrome to render instead of the view, or the items to render as the view.
 *
 * `notice` is rendered *alongside* the items rather than instead of them: filters live only in the
 * address, so a view showing four of nine items has no other way to say that five are being held
 * back. Null whenever there is nothing being held back.
 */
export type ViewChrome<TValue> =
  | { readonly kind: 'chrome'; readonly node: ReactNode }
  | {
      readonly kind: 'items';
      readonly items: readonly Item[];
      readonly drawable: TValue;
      readonly notice: ReactNode | null;
    };

export interface ViewChromeArgs<TValue> {
  readonly container: ContainerData;
  readonly viewState: ViewStateControl;

  /** How the view names itself mid-sentence: "this board", "this list", "this calendar". */
  readonly subject: string;

  readonly drawable: Drawable<TValue>;

  /** What this view says when the container really is empty, and the way out of it. */
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly emptyAction?: ReactNode;

  /**
   * What this view says when the filters have hidden every item, given how many there are.
   *
   * The count is the whole point of the sentence: "no items match" leaves open the possibility that
   * the container was empty all along, and the number is the proof that it was not.
   */
  readonly filtered: (total: number) => ViewChromeMessage;

  /** How the items are ordered. Null leaves them in the order somebody arranged them by hand. */
  readonly sortBy: string | null;
  readonly descending: boolean;
}

export function resolveViewChrome<TValue>(args: ViewChromeArgs<TValue>): ViewChrome<TValue> {
  const { container, viewState, subject } = args;

  if (container.status === 'loading') {
    return {
      kind: 'chrome',
      node: <LoadingPanel label={subject} />,
    };
  }

  if (container.status === 'error') {
    return {
      kind: 'chrome',
      node: (
        <ErrorPanel
          title={`${capitalise(subject)} could not be loaded`}
          detail={container.error ?? `The contents of ${subject} could not be read.`}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void container.reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ),
    };
  }

  // Before anything about items: can this be drawn at all? Checked after the two states above, so a
  // view whose schema has not arrived yet is never accused of naming a property that does not
  // exist - it has not been told what exists.
  if (args.drawable.kind === 'undrawable') {
    return {
      kind: 'chrome',
      node: <ErrorPanel title={args.drawable.title} detail={args.drawable.detail} />,
    };
  }

  if (container.children.length === 0) {
    return {
      kind: 'chrome',
      node: (
        <EmptyPanel
          title={args.emptyTitle}
          detail={args.emptyDetail}
          // An empty state is exactly when somebody most needs the way out of it.
          {...(args.emptyAction === undefined ? {} : { action: args.emptyAction })}
        />
      ),
    };
  }

  const visible = applyFilters(container.children, viewState.filters);

  if (visible.length === 0) {
    // Emptiness we caused rather than emptiness we found, and told apart from it deliberately:
    // somebody who followed a filtered link and is told "nothing in here yet" goes looking for
    // items they think have been deleted.
    const message = args.filtered(container.children.length);

    return {
      kind: 'chrome',
      node: (
        <EmptyPanel
          title={message.title}
          detail={message.detail}
          // The filters are in the address, which is not somewhere this screen can point at.
          action={
            <Button variant="secondary" onClick={viewState.clearFilters}>
              Clear filters
            </Button>
          }
        />
      ),
    };
  }

  const hidden = container.children.length - visible.length;

  return {
    kind: 'items',
    items: sortItems(visible, args.sortBy, args.descending),
    drawable: args.drawable.value,
    notice: hidden === 0 ? null : <PartialNotice pending={hiddenNotice(hidden)} />,
  };
}

/**
 * What a view says about the items its filters are holding back.
 *
 * Worth saying out loud because nothing else on screen says it: this build carries the filters in
 * the address and nowhere else, so a view drawing four of nine items looks exactly like a container
 * holding four.
 */
function hiddenNotice(hidden: number): string {
  return hidden === 1
    ? 'One more item is here and hidden by the current filters.'
    : `${String(hidden)} more items are here and hidden by the current filters.`;
}

/** "this board" as the first two words of a sentence. */
function capitalise(subject: string): string {
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}
