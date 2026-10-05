import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Skeleton> - the shape of content that is on its way.
 *
 * A loading state that is a sentence in the middle of an empty page makes every open feel like a
 * page load: the layout arrives in one piece when the data does, and everything jumps. A skeleton
 * draws the layout first, in the positions the content will take, so arrival is text filling in
 * rather than a page being replaced. That continuity is most of what reads as "native".
 *
 * **It is decoration, never the state.** Every skeleton is `aria-hidden`; the caller keeps the
 * accessible loading state (a `status` region naming what it waits for) beside it, so a screen
 * reader hears exactly what it heard before a skeleton existed. `SkeletonLines` below is that
 * pairing done once for the common case.
 *
 * **Motion is optional.** The pulse stops under `prefers-reduced-motion`; the shapes stay.
 */

const skeletonVariants = cva(
  'block animate-pulse rounded-sm bg-foreground/7 motion-reduce:animate-none',
  {
    variants: {
      shape: {
        // One line of body text: the height of the body step's line, not of its glyphs, so a
        // column of lines occupies the space the paragraph will.
        line: 'h-[1lh]',
        // A heading: taller and bolder in the eye, the same way the heading it stands for is.
        heading: 'h-[1.4lh]',
        // A picture, a chart, a card body: whatever the caller sizes it to.
        block: 'h-full w-full',
      },
    },
    defaultVariants: { shape: 'line' },
  },
);

export interface SkeletonProps {
  readonly shape?: 'line' | 'heading' | 'block';
  /** Layout only - width, height, margins. The fill and the motion are the skeleton's own. */
  readonly className?: string;
}

export function Skeleton({ shape, className }: SkeletonProps): ReactNode {
  return <span aria-hidden="true" className={cn(skeletonVariants({ shape }), className)} />;
}

/** Widths for a column of lines, ragged the way real prose is so it does not read as a table. */
const RAGGED = ['w-11/12', 'w-full', 'w-4/5', 'w-full', 'w-3/5', 'w-5/6', 'w-2/3'] as const;

export interface SkeletonLinesProps {
  /** What is loading, said to assistive technology in place of the shapes. */
  readonly label: string;
  /** How many lines to draw. */
  readonly lines?: number;
  /** Draw a heading-sized line first. */
  readonly heading?: boolean;
  /** Layout only. */
  readonly className?: string;
}

/**
 * A ragged column of lines standing in for prose, with the loading state announced beside it.
 * The region is a polite `status` with `aria-busy`, the same contract the app's loading panels
 * keep, and its only text is the label - visually hidden, because the shapes say it for sighted
 * readers.
 */
export function SkeletonLines({
  label,
  lines = 5,
  heading = false,
  className,
}: SkeletonLinesProps): ReactNode {
  return (
    <div role="status" aria-busy={true} className={cn('flex flex-col gap-2', className)}>
      <span className="sr-only">{label}</span>
      {heading ? <Skeleton shape="heading" className="mb-2 w-1/2" /> : null}
      {Array.from({ length: lines }, (_unused, index) => (
        <Skeleton key={index} className={RAGGED[index % RAGGED.length] ?? 'w-full'} />
      ))}
    </div>
  );
}
