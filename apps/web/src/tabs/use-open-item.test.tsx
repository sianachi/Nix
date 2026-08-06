import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetAnnouncements, useAnnouncement } from '../app/announcer';
import { useTabStore } from './tab-store';
import { useOpenItem } from './use-open-item';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';

function wrapperAt(search: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[`/?${search}`]}>{children}</MemoryRouter>
  );
}

function renderOpenItem(search: string) {
  return renderHook(
    () => ({ open: useOpenItem(), params: useSearchParams()[0], announcement: useAnnouncement() }),
    { wrapper: wrapperAt(search) },
  );
}

beforeEach(() => {
  useTabStore.setState({ byPane: {} });
  resetAnnouncements();
});

describe('previewing a document', () => {
  it('selects it in the current pane and records it as a preview tab, when it is not open anywhere', () => {
    const { result } = renderOpenItem(`item=${A}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    expect(result.current.params.get('item')).toBe(B);
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: B, pinned: false }]);
  });

  it('focuses the pane a document is already pinned in, rather than opening a second copy', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: B, pinned: true }] } });
    const { result } = renderOpenItem(`item=${A}&item2=${C}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    // Pane 0 is untouched - the document belongs to pane 1, which the address now shows.
    expect(result.current.params.get('item')).toBe(A);
    expect(result.current.params.get('item2')).toBe(B);
    // Focusing an existing tab never demotes it.
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: B, pinned: true }]);
    expect(result.current.announcement.text).toContain('Already open in pane 2.');
  });

  it('does nothing when the document is already the pane it is open in', () => {
    const { result } = renderOpenItem(`item=${A}&item2=${B}`);

    act(() => {
      result.current.open.openPreview(B);
    });

    expect(result.current.params.get('item')).toBe(A);
    expect(result.current.params.get('item2')).toBe(B);
  });
});

describe('pinning a document', () => {
  it('opens and pins it in the current pane, when it is not open anywhere', () => {
    const { result } = renderOpenItem(`item=${A}`);

    act(() => {
      result.current.open.openPinned(B);
    });

    expect(result.current.params.get('item')).toBe(B);
    expect(useTabStore.getState().byPane[0]).toEqual([{ itemId: B, pinned: true }]);
  });

  it('promotes an already-open preview tab in another pane rather than duplicating it', () => {
    useTabStore.setState({ byPane: { 1: [{ itemId: B, pinned: false }] } });
    const { result } = renderOpenItem(`item=${A}&item2=${B}`);

    act(() => {
      result.current.open.openPinned(B);
    });

    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: B, pinned: true }]);
  });
});

describe('opening a document beside', () => {
  it('opens a new pane and pins it there immediately', () => {
    const { result } = renderOpenItem(`item=${A}`);

    let openedPane: number | null = null;
    act(() => {
      openedPane = result.current.open.openBeside(B);
    });

    expect(openedPane).toBe(1);
    expect(result.current.params.get('item2')).toBe(B);
    expect(useTabStore.getState().byPane[1]).toEqual([{ itemId: B, pinned: true }]);
  });

  it('focuses and pins an already-open backgrounded tab instead of opening a duplicate pane', () => {
    useTabStore.setState({
      byPane: {
        0: [
          { itemId: A, pinned: true },
          { itemId: B, pinned: false },
        ],
      },
    });
    const { result } = renderOpenItem(`item=${A}`);

    let openedPane: number | null = null;
    act(() => {
      openedPane = result.current.open.openBeside(B);
    });

    expect(openedPane).toBe(0);
    expect(result.current.params.get('item2')).toBeNull();
    expect(result.current.params.get('item')).toBe(B);
    expect(useTabStore.getState().byPane[0]).toEqual([
      { itemId: A, pinned: true },
      { itemId: B, pinned: true },
    ]);
  });
});
