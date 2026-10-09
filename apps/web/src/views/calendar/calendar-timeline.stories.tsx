import { within } from '@testing-library/dom';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { View } from '../core/container-model';
import { storyContainer, storyItem } from '../core/story-container';
import { VIEW_GUTTER } from '../core/view-gutter';
import { TimelineView } from '../timeline/timeline-view';
import { CalendarView } from './calendar-view';

export default { title: 'Nix/Views/Calendar and timeline', parameters: { layout: 'padded' } };

function Example({ kind }: { readonly kind: 'calendar' | 'timeline' }): ReactNode {
  const now = new Date();
  const date = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const view: View = {
    id: kind,
    name: 'Plans',
    kind,
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: 'starts',
    endDateProperty: 'ends',
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
  };
  const container = storyContainer(
    [
      storyItem('today', 'A long plan title that remains reachable on a small phone', 1, {
        starts: date,
        ends: date,
      }),
      storyItem('later', 'An idea to schedule', 2),
    ],
    [
      { key: 'starts', label: 'Starts', type: 'date', options: [], required: false },
      { key: 'ends', label: 'Ends', type: 'date', options: [], required: false },
    ],
  );
  const props = { container, view, onOpen: () => undefined };
  return (
    <MemoryRouter>
      <div className={VIEW_GUTTER}>
        {kind === 'calendar' ? <CalendarView {...props} /> : <TimelineView {...props} />}
      </div>
    </MemoryRouter>
  );
}

export const Calendar = { render: (): ReactNode => <Example kind="calendar" /> };
export const Timeline = { render: (): ReactNode => <Example kind="timeline" /> };
export const CalendarPhone = {
  ...Calendar,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const TimelinePhone = {
  ...Timeline,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const DarkCalendarPhone = { ...CalendarPhone, globals: { ground: 'dark' } };
export const DarkTimelinePhone = { ...TimelinePhone, globals: { ground: 'dark' } };

function checkNarrowView({ canvasElement }: { readonly canvasElement: HTMLElement }): void {
  const region = within(canvasElement).getByRole('region', { name: 'Narrow calendar view' });
  if (region.scrollWidth > region.clientWidth) {
    throw new Error('Calendar and timeline controls must fit within a narrow pane.');
  }
}

export const TinyCalendar = {
  render: (): ReactNode => (
    <section aria-label="Narrow calendar view" className="w-64 max-w-full">
      <Example kind="calendar" />
    </section>
  ),
  play: checkNarrowView,
};
export const TinyTimeline = {
  render: (): ReactNode => (
    <section aria-label="Narrow calendar view" className="w-64 max-w-full">
      <Example kind="timeline" />
    </section>
  ),
  play: checkNarrowView,
};
export const DarkTinyCalendar = { ...TinyCalendar, globals: { ground: 'dark' } };
export const DarkTinyTimeline = { ...TinyTimeline, globals: { ground: 'dark' } };
