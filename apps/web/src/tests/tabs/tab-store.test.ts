import { beforeEach, describe, expect, it } from 'vitest';

import { useTabStore } from '../../tabs/tab-store';

function tabs(pane: number): readonly { itemId: string; pinned: boolean }[] {
  return useTabStore.getState().byPane[pane] ?? [];
}

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
});

describe('previewing a document', () => {
  it('opens it as an unpinned tab', () => {
    useTabStore.getState().tabPreviewed(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: false }]);
  });

  it('replaces the pane’s existing preview tab in place', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
      },
    });

    useTabStore.getState().tabPreviewed(0, 'c');

    expect(tabs(0)).toEqual([
      { itemId: 'a', pinned: true },
      { itemId: 'c', pinned: false },
    ]);
  });

  it('does not demote a tab that is already pinned', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    useTabStore.getState().tabPreviewed(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
  });

  it('keeps each pane’s strip separate', () => {
    useTabStore.getState().tabPreviewed(0, 'a');
    useTabStore.getState().tabPreviewed(1, 'b');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: false }]);
    expect(tabs(1)).toEqual([{ itemId: 'b', pinned: false }]);
  });
});

describe('pinning a document', () => {
  it('promotes an already-open preview tab in place', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
      },
    });

    useTabStore.getState().tabPinned(0, 'b');

    expect(tabs(0)).toEqual([
      { itemId: 'a', pinned: true },
      { itemId: 'b', pinned: true },
    ]);
  });

  it('inserts a pinned tab directly when the document was not already open', () => {
    useTabStore.getState().tabPinned(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
  });
});

describe('closing a tab', () => {
  it('removes only that tab', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: 'a', pinned: true },
          { itemId: 'b', pinned: false },
        ],
      },
    });

    useTabStore.getState().tabClosed(0, 'a');

    expect(tabs(0)).toEqual([{ itemId: 'b', pinned: false }]);
  });
});

describe('closing a pane', () => {
  it('drops the closed pane’s tabs and leaves an untouched pane alone', () => {
    useTabStore.setState({
      byPane: { 0: [{ itemId: 'a', pinned: true }], 1: [{ itemId: 'b', pinned: true }] },
    });

    useTabStore.getState().paneClosed(1, 2);

    expect(tabs(0)).toEqual([{ itemId: 'a', pinned: true }]);
    expect(useTabStore.getState().byPane[1]).toBeUndefined();
  });

  it('renumbers the panes after the one that closed, the same order the address shifts in', () => {
    useTabStore.setState({
      byPane: {
        0: [{ itemId: 'a', pinned: true }],
        1: [{ itemId: 'b', pinned: true }],
        2: [{ itemId: 'c', pinned: true }],
      },
    });

    useTabStore.getState().paneClosed(0, 3);

    expect(tabs(0)).toEqual([{ itemId: 'b', pinned: true }]);
    expect(tabs(1)).toEqual([{ itemId: 'c', pinned: true }]);
    expect(useTabStore.getState().byPane[2]).toBeUndefined();
  });

  it('leaves no stale entry when the shifted-down pane never had tabs recorded', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    useTabStore.getState().paneClosed(0, 2);

    expect(useTabStore.getState().byPane[0]).toBeUndefined();
  });
});
