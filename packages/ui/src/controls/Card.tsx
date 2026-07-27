import { type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { Text } from '../primitives/Text';

/**
 * <Card> - a titled blueprint figure.
 *
 * A line drawing on a lifted surface, softly cornered, holding a
 * kicker, a title and a body. There is no fill prop and no radius prop: Industry cards are line
 * drawings, and that is an invariant of the component rather than a convention each page has to
 * remember.
 *
 * The title's heading level is the caller's choice because a card slots into a page's heading
 * outline and cannot know its own depth. Defaulting to `h2` and letting a caller move it is what
 * keeps the outline sound; hard-coding one would break it on the first page that nests a card.
 *
 * A `<section>` rather than an `<article>`: a card is part of the page it sits on, not a
 * self-contained thing that would still make sense syndicated on its own.
 */

export interface CardProps {
  readonly title: string;
  readonly children: ReactNode;

  /** A short label above the title - a category, a state, a section name. */
  readonly kicker?: string;

  /** Where the title sits in the page's heading outline. */
  readonly headingLevel?: 2 | 3 | 4;

  /** An accessible name for the section, when the title is not the whole story. */
  readonly 'aria-label'?: string;

  /** Layout only - margin, width, grid placement. Never a restyle of the frame. */
  readonly className?: string;
}

export function Card(props: CardProps): ReactNode {
  const { title, children, kicker, headingLevel = 2, className } = props;
  // The variant and the element are the same name by construction, which is what keeps a card's
  // visual weight and its place in the heading outline from drifting apart.
  const heading = `h${String(headingLevel)}` as 'h2' | 'h3' | 'h4';

  return (
    <section
      aria-label={props['aria-label']}
      // A resting shadow, not a hover one. The card is a surface in front of the ground rather
      // than something that lifts when noticed, and depth that only appears under a pointer is
      // depth that never exists on a touch screen or under a keyboard.
      className={cn(blueprintFrame, 'flex flex-col gap-4 bg-surface p-6 shadow-sm', className)}
    >
      {/* A plain div rather than a <header>: the only banner in the document is the application
          header, and a card announcing itself as one would put two in the landmark list. */}
      <div className="flex flex-col gap-1">
        {kicker === undefined ? null : <Text variant="kicker">{kicker}</Text>}
        <Text variant={heading}>{title}</Text>
      </div>

      {children}
    </section>
  );
}
