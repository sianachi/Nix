import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useTabStore } from './tab-store';
import { useDocumentTabs } from './use-document-tabs';

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
});

describe('the tab strip a pane draws', () => {
  it('shows the active item as an unpinned tab when the store has never heard of it', () => {
    const { result } = renderHook(() => useDocumentTabs(0, 'a'));

    expect(result.current.tabs).toEqual([{ itemId: 'a', pinned: false }]);
  });

  it('does not duplicate the active item when it is already tracked', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    const { result } = renderHook(() => useDocumentTabs(0, 'a'));

    expect(result.current.tabs).toEqual([{ itemId: 'a', pinned: true }]);
  });

  it('appends the active item alongside tabs already tracked for the pane', () => {
    useTabStore.setState({ byPane: { 0: [{ itemId: 'a', pinned: true }] } });

    const { result } = renderHook(() => useDocumentTabs(0, 'b'));

    expect(result.current.tabs).toEqual([
      { itemId: 'a', pinned: true },
      { itemId: 'b', pinned: false },
    ]);
  });

  it('reads only its own pane’s tabs', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: 'z', pinned: true }] } });

    const { result } = renderHook(() => useDocumentTabs(0, 'a'));

    expect(result.current.tabs).toEqual([{ itemId: 'a', pinned: false }]);
  });
});
