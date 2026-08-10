import type { ReactElement } from 'react';

import { paneScroller } from '../app/layout';
import { EmptyPanel } from '../components/states/status-panels';

/**
 * The graph destination, routed and named and nothing else yet. See `calendar-page.tsx` for why a
 * placeholder says so out loud rather than drawing an empty canvas.
 */
export function GraphPage(): ReactElement {
  return (
    <div className={`${paneScroller} p-4`}>
      <EmptyPanel
        title="Graph"
        detail="Not built yet. This destination is routed and reachable; the link graph itself arrives in a later goal."
      />
    </div>
  );
}
