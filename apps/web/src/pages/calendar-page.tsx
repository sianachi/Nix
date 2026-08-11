import type { ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { EmptyPanel } from '../components/states/status-panels';

/**
 * The calendar destination, routed and named and nothing else yet.
 *
 * The rail that points here landed before the view did, so this says exactly that rather than
 * standing in with a plausible-looking empty week - a screen that looks built and holds nothing is
 * the dishonest state CLAUDE.md's UI-truthfulness rule exists to rule out.
 */
export function CalendarPage(): ReactElement {
  return (
    <div className={`${paneScroller} p-4`}>
      <EmptyPanel
        title="Calendar"
        detail="Not built yet. This destination is routed and reachable; the calendar itself arrives in a later goal."
      />
    </div>
  );
}
