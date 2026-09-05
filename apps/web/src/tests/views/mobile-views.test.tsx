import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ContainerView } from '../../views/core/container-view';
import { aContainer } from '../container-fixture';
import { aView } from '../view-fixture';
import { item } from '../api-stub';
import { renderAt } from '../render-with-router';
import { stubViewport } from '../stub-viewport';

beforeEach(() => {
  stubViewport(false);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
const now = new Date();
const today = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const note = item({
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'Release plan',
  properties: { due: today },
});

it('browses spreadsheet records on phones while retaining an explicit grid', async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({ children: [note] })}
      view={aView({ kind: 'sheet' })}
      onOpen={onOpen}
    />,
  );
  expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Release plan' }));
  expect(onOpen).toHaveBeenCalledWith(note.id);
  await user.click(screen.getByRole('button', { name: 'Show spreadsheet grid' }));
  expect(screen.getByRole('grid')).toBeInTheDocument();
});

it('shows dated calendar items in an agenda and keeps undated items available', async () => {
  const user = userEvent.setup();
  const undated = item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Unscheduled idea' });
  const onOpen = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({ children: [note, undated] })}
      view={aView({ kind: 'calendar', dateProperty: 'due' })}
      onOpen={onOpen}
    />,
  );
  const agenda = screen.getByRole('region', { name: 'Calendar agenda' });
  await user.click(within(agenda).getByRole('button', { name: 'Release plan' }));
  expect(onOpen).toHaveBeenCalledWith(note.id);
  expect(screen.getByRole('button', { name: 'Unscheduled idea' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show calendar grid' }));
  expect(screen.queryByRole('region', { name: 'Calendar agenda' })).not.toBeInTheDocument();
});

it('offers timeline rescheduling without requiring a horizontal grid', async () => {
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({ children: [note] })}
      view={aView({ kind: 'timeline', dateProperty: 'due' })}
      onOpen={vi.fn()}
    />,
  );
  const schedule = screen.getByRole('region', { name: 'Timeline schedule' });
  expect(within(schedule).getByText(today)).toBeInTheDocument();
  await user.click(within(schedule).getByRole('button', { name: 'Reschedule Release plan' }));
  expect(
    within(screen.getByRole('region', { name: 'Reschedule Release plan' })).getByRole('button', {
      name: 'Done',
    }),
  ).toBeInTheDocument();
});
