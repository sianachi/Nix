import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Blueprint } from './blueprint';
import { Heading, Kicker } from './typography';

/**
 * A content card: a blueprint frame with a kicker, a title and a body. There
 * is no fill prop and no radius prop - Industry cards are transparent line
 * drawings with square corners, and that is an invariant of the component
 * rather than a convention a page has to honour.
 *
 * The title renders as an h-level the caller chooses, so a card can slot into
 * a page's heading outline without breaking it.
 */

interface CardProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly kicker?: string | undefined;
  readonly headingLevel?: 2 | 3 | 4;
  readonly className?: string | undefined;
}

export function Card({
  title,
  children,
  kicker,
  headingLevel = 2,
  className,
}: CardProps): ReactElement {
  return (
    <Blueprint as="section" className={cx('flex flex-col gap-4 p-6', className)}>
      {/* A plain div, not a <header>: the only banner in the document is the
          application header in the root layout. */}
      <div className="flex flex-col gap-1">
        {kicker !== undefined ? <Kicker>{kicker}</Kicker> : null}
        <Heading level={headingLevel}>{title}</Heading>
      </div>
      {children}
    </Blueprint>
  );
}
