import type { ReactElement } from 'react';

import { paneScroller } from '../layout/regions';
import { EmptyPanel } from '../components/states/status-panels';

/**
 * The bookmarks destination, routed and named and nothing else yet. See `calendar-page.tsx` for
 * why a placeholder says so out loud rather than rendering an empty list that reads as "you have
 * no bookmarks".
 */
export function BookmarksPage(): ReactElement {
  return (
    <div className={`${paneScroller} p-4`}>
      <EmptyPanel
        title="Bookmarks"
        detail="Not built yet. This destination is routed and reachable; saved items arrive in a later goal."
      />
    </div>
  );
}
