import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { dailyNoteTitle } from '../../daily-notes/daily-note';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

beforeEach(() => {
  signedIn();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 30, 9, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

async function selectedDailyNote(): Promise<HTMLElement> {
  let selected: HTMLElement | undefined;
  await waitFor(() => {
    selected = screen
      .getAllByRole('treeitem', { name: /2026-08-30/i })
      .find((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toBeDefined();
  });
  return selected ?? document.body;
}

describe('daily notes', () => {
  it('uses the local calendar date in the familiar daily-note format', () => {
    expect(dailyNoteTitle(new Date(2026, 0, 5, 23, 30, 0))).toBe('2026-01-05');
  });

  it("opens today's existing note instead of creating another one", async () => {
    const root = item({
      id: 'da110000-0000-4000-8000-000000000001',
      title: 'Daily notes',
      hasChildren: true,
    });
    const today = item({
      id: 'da110000-0000-4000-8000-000000000002',
      title: '2026-08-30',
      parentId: root.id,
    });
    stubCoreApi({ items: [root, today] });

    renderAt(<App />, '/daily');

    const row = await selectedDailyNote();
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it("creates the daily-notes group and today's note in an empty workspace", async () => {
    stubCoreApi();

    renderAt(<App />, '/daily');

    const roots = await screen.findAllByRole('treeitem', { name: /daily notes/i });
    expect(roots.some((root) => root.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(await selectedDailyNote()).toHaveAttribute('aria-selected', 'true');
  });
});
