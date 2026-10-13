import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Table, type TableColumn } from './Table';

interface Document {
  readonly id: string;
  readonly title: string;
  readonly words: number;
}

const ROWS: Document[] = [
  { id: 'a', title: 'Onboarding', words: 1200 },
  { id: 'b', title: 'Retention policy', words: 340 },
];

const COLUMNS: TableColumn<Document>[] = [
  { key: 'title', header: 'Title', cell: (row) => row.title, sortable: true, rowHeader: true },
  { key: 'words', header: 'Words', cell: (row) => row.words, sortable: true, align: 'end' },
];

const resizeNotifications: (() => void)[] = [];
beforeEach(() => {
  resizeNotifications.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeNotifications.push(() => {
          callback([], this);
        });
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTable(overrides: Partial<Parameters<typeof Table<Document>>[0]> = {}) {
  return render(
    <Table
      caption="Documents in this workspace"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(row) => row.id}
      emptyMessage="No documents yet."
      {...overrides}
    />,
  );
}

describe('Table', () => {
  it('names itself with its caption', () => {
    renderTable();

    expect(screen.getByRole('table', { name: 'Documents in this workspace' })).toBeInTheDocument();
  });

  it('renders a header per column and a row per record', () => {
    renderTable();

    expect(screen.getByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Words' })).toBeInTheDocument();
    // The header row counts too, which is what makes the header a row at all.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('announces the column a row belongs to via its row header', () => {
    renderTable();

    expect(screen.getByRole('rowheader', { name: 'Onboarding' })).toBeInTheDocument();
  });

  it('reports the sort a header click asks for without applying it', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable({ onSortChange });

    await user.click(screen.getByRole('button', { name: 'Words' }));

    expect(onSortChange).toHaveBeenCalledWith({ columnKey: 'words', direction: 'ascending' });
    // Still in the order it was handed: the component renders the sort, it never performs one.
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'Onboarding',
      'Retention policy',
    ]);
  });

  it('reverses the column that is already sorted', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable({ onSortChange, sort: { columnKey: 'title', direction: 'ascending' } });

    await user.click(screen.getByRole('button', { name: 'Title' }));

    expect(onSortChange).toHaveBeenCalledWith({ columnKey: 'title', direction: 'descending' });
  });

  it('starts a different column ascending rather than inheriting the old direction', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable({ onSortChange, sort: { columnKey: 'title', direction: 'descending' } });

    await user.click(screen.getByRole('button', { name: 'Words' }));

    expect(onSortChange).toHaveBeenCalledWith({ columnKey: 'words', direction: 'ascending' });
  });

  it('states which column is sorted and which way', () => {
    renderTable({ onSortChange: vi.fn(), sort: { columnKey: 'words', direction: 'descending' } });

    expect(screen.getByRole('columnheader', { name: 'Words' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('offers no sort at all when nobody is listening for one', () => {
    renderTable();

    // A header that looks clickable and does nothing is worse than one that never offered.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Title' })).not.toHaveAttribute('aria-sort');
  });

  it('leaves aria-sort off a column that cannot be sorted', () => {
    render(
      <Table
        caption="Documents"
        columns={[{ key: 'title', header: 'Title', cell: (row: Document) => row.title }]}
        rows={ROWS}
        rowKey={(row) => row.id}
        emptyMessage="No documents yet."
        onSortChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Title' })).not.toHaveAttribute('aria-sort');
  });

  it('says there is nothing once the answer has arrived and the answer is none', () => {
    renderTable({ rows: [] });

    expect(screen.getByText('No documents yet.')).toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-busy');
  });

  it('never claims emptiness while it is still loading', () => {
    renderTable({ rows: [], loading: true });

    // The crown jewel of an honest table: "no documents" is a fact the reader will act on, and it
    // must not be said before it is known.
    expect(screen.queryByText('No documents yet.')).not.toBeInTheDocument();
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('says it is working even when it still has the previous rows in hand', () => {
    renderTable({ loading: true, loadingMessage: 'Reloading documents' });

    expect(screen.getByText('Reloading documents')).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'Onboarding' })).not.toBeInTheDocument();
  });

  it('spans the message across every column so it reads as an answer, not a gap', () => {
    renderTable({ rows: [] });

    expect(screen.getByRole('cell')).toHaveAttribute('colspan', '2');
  });

  it('accepts a layout class without losing its own width', () => {
    renderTable({ className: 'mt-4' });

    const className = screen.getByRole('table').className;
    expect(className).toContain('mt-4');
    expect(className).toContain('w-full');
  });

  it('announces sparse virtual rows in the complete table and preserves their geometry', () => {
    const { container } = renderTable({
      virtualization: {
        totalRows: 100,
        rowIndexes: [10, 11],
        spacerHeights: [450, 0, 3_960],
      },
    });

    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '101');
    expect(screen.getByRole('rowheader', { name: 'Onboarding' }).parentElement).toHaveAttribute(
      'aria-rowindex',
      '12',
    );
    expect(
      screen.getByRole('rowheader', { name: 'Retention policy' }).parentElement,
    ).toHaveAttribute('aria-rowindex', '13');
    expect(
      [...container.querySelectorAll('tr[aria-hidden="true"] td')].map(
        (cell) => (cell as HTMLElement).style.height,
      ),
    ).toEqual(['450px', '3960px']);
  });

  it('offers the row actions the caller builds for the row that was secondary-clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderTable({
      rowContextMenu: (row) => [{ kind: 'action', label: `Open ${row.title}`, onSelect }],
    });

    const opened = fireEvent.contextMenu(
      screen.getByRole('rowheader', { name: 'Retention policy' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Open Retention policy' }));

    expect(opened).toBe(false);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('draws no resize handles unless somebody is listening for a width', () => {
    renderTable();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('announces automatic width and resizes from the measured column width', async () => {
    const onColumnResize = vi.fn();
    const onColumnWidthReset = vi.fn();
    const bounds = new DOMRect(0, 0, 240, 40);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    renderTable({ onColumnResize, onColumnWidthReset });
    const handle = screen.getByRole('separator', { name: 'Resize column Title' });

    expect(handle).toHaveAttribute('aria-valuenow', '240');
    expect(handle).toHaveAttribute('aria-valuemin', '64');
    expect(handle).toHaveAttribute('aria-valuemax', '800');
    expect(handle).toHaveAttribute('aria-valuetext', 'automatic width');

    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onColumnResize).toHaveBeenLastCalledWith('title', 256);
    bounds.width = 320;
    act(() => {
      for (const notify of resizeNotifications) notify();
    });
    expect(handle).toHaveAttribute('aria-valuenow', '320');
    await userEvent.keyboard('{ArrowLeft}');
    expect(onColumnResize).toHaveBeenLastCalledWith('title', 304);
    await userEvent.keyboard('{Home}');
    expect(onColumnWidthReset).toHaveBeenCalledWith('title');
  });

  it.each([
    { width: 0, minimum: '0', maximum: '800' },
    { width: 48, minimum: '48', maximum: '800' },
    { width: 1200, minimum: '64', maximum: '1200' },
  ])('includes an automatic width of $width in the announced range', (range) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, range.width, 40),
    );
    renderTable({ onColumnResize: vi.fn() });
    const handle = screen.getByRole('separator', { name: 'Resize column Title' });

    expect(handle).toHaveAttribute('aria-valuenow', String(range.width));
    expect(handle).toHaveAttribute('aria-valuemin', range.minimum);
    expect(handle).toHaveAttribute('aria-valuemax', range.maximum);
    expect(handle).toHaveAttribute('aria-valuetext', 'automatic width');
  });

  it('resizes a column from the keyboard, one step at a time, and resets from Home', async () => {
    const onColumnResize = vi.fn();
    const onColumnWidthReset = vi.fn();
    renderTable({ columnWidths: { title: 240 }, onColumnResize, onColumnWidthReset });
    const handle = screen.getByRole('separator', { name: 'Resize column Title' });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
    expect(screen.getByRole('columnheader', { name: /title/i })).toHaveStyle({ width: '240px' });

    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onColumnResize).toHaveBeenLastCalledWith('title', 256);
    await userEvent.keyboard('{ArrowLeft}');
    expect(onColumnResize).toHaveBeenLastCalledWith('title', 224);
    await userEvent.keyboard('{Home}');
    expect(onColumnWidthReset).toHaveBeenCalledWith('title');
  });

  it('keeps a drag on the handle from sorting the column behind it', () => {
    const onSortChange = vi.fn();
    const onColumnResize = vi.fn();
    renderTable({ onSortChange, onColumnResize, columnWidths: { title: 200 } });
    const handle = screen.getByRole('separator', { name: 'Resize column Title' });
    // jsdom has no pointer capture; the handle asks for it so a fast drag stays on the handle.
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.click(handle);
    expect(onColumnResize).toHaveBeenLastCalledWith('title', 240);
    expect(onSortChange).not.toHaveBeenCalled();
  });
});
