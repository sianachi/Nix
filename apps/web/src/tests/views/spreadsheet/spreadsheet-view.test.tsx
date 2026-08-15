import { fireEvent, screen } from '@testing-library/react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import { SpreadsheetView } from '../../../views/spreadsheet/spreadsheet-view';

/**
 * The spreadsheet view, driven the way a person drives it: one focused scroller, arrows, typing,
 * and the clipboard. Cells are painted text with `aria-activedescendant` naming the active one, so
 * these tests assert on cell labels and on the writes the grid makes - not on per-cell controls,
 * which the grid deliberately does not mount.
 */

function item(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function property(key: string, label: string, type: string): PropertyDefinition {
  return { key, label, type, options: [], required: false };
}

function schemaOf(...properties: PropertyDefinition[]): EffectiveSchema {
  return { properties, declared: properties, inherit: true };
}

const SCHEMA = schemaOf(
  property('status', 'Status', 'select'),
  property('count', 'Count', 'number'),
);

const writes: { itemId: string; bag: Record<string, unknown> }[] = [];

beforeEach(() => {
  writes.length = 0;
  // jsdom has no ResizeObserver; the grid only uses it to track viewport size, which stays 0x0
  // here - the first rows and columns still render through the overscan.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

/**
 * A spreadsheet wired to a stand-in for `useContainer`: the write is optimistic, and a refusal
 * puts the value back and answers with the reason - the same real round trip the list's harness
 * makes, because a rollback only is one if the optimistic value reached the screen first.
 */
function sheetWith(options: {
  readonly items: readonly Item[];
  readonly schema?: EffectiveSchema;
  readonly view?: View;
  readonly refuse?: string;
  readonly truncated?: boolean;
  readonly onOpen?: (itemId: string) => void;
}): ReactElement {
  function Harness(): ReactNode {
    const [children, setChildren] = useState<readonly Item[]>(options.items);

    function applyBag(itemId: string, properties: Record<string, unknown>): void {
      setChildren((current) =>
        current.map((entry) =>
          entry.id === itemId
            ? { ...entry, properties: { ...entry.properties, ...properties } }
            : entry,
        ),
      );
    }

    const container: ContainerData = aContainer({
      schema: options.schema ?? SCHEMA,
      children,
      truncated: options.truncated ?? false,
      setProperties: async (itemId, properties) => {
        writes.push({ itemId, bag: properties });
        applyBag(itemId, properties);

        await new Promise((resolve) => setTimeout(resolve, 0));

        if (options.refuse === undefined) {
          return null;
        }

        setChildren(options.items);
        return options.refuse;
      },
      // The bulk channel paste, fill and clear use: same optimistic-then-answer round trip, with
      // the whole gesture answered at once the way the real hook answers it.
      setPropertiesMany: async (planWrites) => {
        for (const write of planWrites) {
          writes.push({ itemId: write.itemId, bag: write.properties });
          applyBag(write.itemId, write.properties);
        }

        await new Promise((resolve) => setTimeout(resolve, 0));

        if (options.refuse === undefined) {
          return { saved: planWrites.length, refused: [] };
        }

        setChildren(options.items);
        return {
          saved: 0,
          refused: planWrites.map((write) => ({
            label: write.label,
            reason: options.refuse ?? '',
          })),
        };
      },
    });

    return (
      <SpreadsheetView
        container={container}
        view={options.view ?? aView({ kind: 'sheet' })}
        onOpen={options.onOpen ?? vi.fn()}
      />
    );
  }

  return <Harness />;
}

/** Reports the address back to the test, so a URL-held sort can be asserted on as a fact. */
function CurrentSearch(): ReactNode {
  const location = useLocation();
  return <p role="status">{location.search}</p>;
}

const ALPHA = item('item-a', 'Alpha', 1, { status: 'open', count: 3 });
const BETA = item('item-b', 'Beta', 2, { status: 'done' });

function grid(): HTMLElement {
  return screen.getByRole('grid');
}

function pressOnGrid(key: string, init: Record<string, unknown> = {}): void {
  fireEvent.keyDown(grid(), { key, ...init });
}

describe('the grid', () => {
  it('carries the full extent in aria counts while mounting only the window', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      item(`item-${String(index)}`, `Item ${String(index)}`, index + 1),
    );
    renderAt(sheetWith({ items: many }));

    expect(grid()).toHaveAttribute('aria-rowcount', '200');
    expect(grid()).toHaveAttribute('aria-colcount', '3');
    // The viewport is 0x0 in jsdom, so what is mounted is exactly the overscan - far fewer rows
    // than the container holds, which is the windowing working.
    expect(screen.getAllByRole('row').length).toBeLessThan(30);
  });

  it('names each cell after its column and its row, with the value read out', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    expect(screen.getByRole('gridcell', { name: 'Status for Alpha, open' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Count for Alpha, 3' })).toBeInTheDocument();
    // An empty cell is named without a value rather than with a dangling comma.
    expect(screen.getByRole('gridcell', { name: 'Count for Beta' })).toBeInTheDocument();
  });

  it('opens an item from its title cell, which is the row header affordance of this grid', () => {
    const onOpen = vi.fn();
    renderAt(sheetWith({ items: [ALPHA, BETA], onOpen }));

    grid().focus();
    pressOnGrid('Enter');

    expect(onOpen).toHaveBeenCalledWith('item-a');
  });
});

describe('editing a cell', () => {
  it('types into a cell, commits on Enter, and writes the coerced value once', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('ArrowRight'); // Count for Alpha
    pressOnGrid('4');

    const editor = screen.getByRole('textbox', { name: 'Edit Count for Alpha' });
    fireEvent.change(editor, { target: { value: '42' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(writes).toEqual([{ itemId: 'item-a', bag: { count: 42 } }]);
    // The overlay is gone and focus is back on the scroller for the next keystroke.
    expect(screen.queryByRole('textbox', { name: 'Edit Count for Alpha' })).toBeNull();
    await Promise.resolve();
  });

  it('keeps a value that is not storable in the editor and says why, rather than writing a guess', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('ArrowRight');
    pressOnGrid('x');

    const editor = screen.getByRole('textbox', { name: 'Edit Count for Alpha' });
    fireEvent.change(editor, { target: { value: 'twelve' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(writes).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Edit Count for Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Count for Alpha: "twelve" is not a number.')).toBeInTheDocument();
  });

  it('surfaces the server refusal beside the grid after the optimistic value is rolled back', async () => {
    renderAt(sheetWith({ items: [ALPHA], refuse: 'Not one of the options.' }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('b');

    const editor = screen.getByRole('textbox', { name: 'Edit Status for Alpha' });
    fireEvent.change(editor, { target: { value: 'blocked' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(
      await screen.findByText('Status for Alpha: Not one of the options.'),
    ).toBeInTheDocument();
    // Rolled back: the cell shows what is really stored.
    expect(screen.getByRole('gridcell', { name: 'Status for Alpha, open' })).toBeInTheDocument();
  });

  it('escapes an edit without writing, and Escape in nav mode is the exit from the grid', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('z');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit Status for Alpha' }), {
      key: 'Escape',
    });

    expect(writes).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Edit Status for Alpha' })).toBeNull();
  });
});

describe('ranges and the clipboard', () => {
  it('copies the selected range as TSV', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowDown', { shiftKey: true });
    pressOnGrid('ArrowRight', { shiftKey: true });

    const setData = vi.fn();
    fireEvent.copy(grid(), { clipboardData: { setData } });

    expect(setData).toHaveBeenCalledWith('text/plain', 'Alpha\topen\nBeta\tdone');
  });

  it('pastes a block as one write per row, coerced per column', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');

    fireEvent.paste(grid(), {
      clipboardData: { getData: () => 'held\t9\nopen\t8' },
    });

    expect(writes).toEqual([
      { itemId: 'item-a', bag: { status: 'held', count: 9 } },
      { itemId: 'item-b', bag: { status: 'open', count: 8 } },
    ]);
  });

  it('says out loud when a pasted value could not become the column value, and stays quiet about structure', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');

    // Row one carries a number column value that is not a number; the rest of the block is fine.
    // Only the value is worth a sentence - a paste that brushes read-only ground is not a failure.
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'held\ttwelve\nopen' } });

    expect(writes).toEqual([
      { itemId: 'item-a', bag: { status: 'held' } },
      { itemId: 'item-b', bag: { status: 'open' } },
    ]);
    expect(
      await screen.findByText('One value could not be taken and was left as it was.'),
    ).toBeInTheDocument();
  });

  it('answers a refused batch with one sentence naming the row, not a race of notices', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA], refuse: 'Not one of the options.' }));

    grid().focus();
    pressOnGrid('ArrowRight');

    fireEvent.paste(grid(), { clipboardData: { getData: () => 'held\nheld' } });

    expect(
      await screen.findByText('2 of 2 rows were refused - Alpha: Not one of the options.'),
    ).toBeInTheDocument();
    // Rolled back: both rows show what is really stored.
    expect(screen.getByRole('gridcell', { name: 'Status for Alpha, open' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Status for Beta, done' })).toBeInTheDocument();
  });

  it('answers a lone Ctrl+D rather than silently ignoring it', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('d', { ctrlKey: true });

    expect(writes).toEqual([]);
    expect(
      screen.getByText('Select rows to fill down: the first row of the selection is the pattern.'),
    ).toBeInTheDocument();
  });

  it('fills the range down from its first row on the incumbent shortcut', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('ArrowDown', { shiftKey: true });
    pressOnGrid('d', { ctrlKey: true });

    expect(writes).toEqual([{ itemId: 'item-b', bag: { status: 'open' } }]);
  });

  it('clears the selected range on Delete, leaving the read-only title alone', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('End'); // whole row to the last column
    pressOnGrid('Home', { shiftKey: true });
    pressOnGrid('Delete');

    expect(writes).toEqual([{ itemId: 'item-a', bag: { status: null, count: null } }]);
  });
});

describe('sorting', () => {
  it('writes a header click to the URL, where the sort lives', () => {
    renderAt(
      <>
        {sheetWith({ items: [ALPHA, BETA] })}
        <CurrentSearch />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Count' }));

    // Two status regions exist by design - the grid's own notice and this probe - so the address
    // is read from whichever of them carries it.
    const addresses = screen.getAllByRole('status').map((region) => region.textContent);
    expect(addresses.some((text) => text.includes('sort=count'))).toBe(true);
  });

  it('orders rows by the view sort when the URL says nothing', () => {
    // Both rows carry a value, so the assertion can only pass through the sort itself - with one
    // blank the empties-last rule would put Alpha first under either direction.
    renderAt(
      sheetWith({
        items: [item('item-a', 'Alpha', 1, { count: 3 }), item('item-b', 'Beta', 2, { count: 9 })],
        view: aView({ kind: 'sheet', sortBy: 'count', sortDescending: true }),
      }),
    );

    const rows = screen.getAllByRole('row');
    expect(rows[0]?.textContent).toContain('Beta');
    expect(rows[1]?.textContent).toContain('Alpha');
  });
});

describe('honesty around the edges', () => {
  it('answers typing over a title instead of swallowing the keystroke', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('n');

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.getByText('A row’s name is changed in the item itself - press Enter to open it.'),
    ).toBeInTheDocument();
  });

  it('commits a click-away edit exactly once', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('b');

    const editor = screen.getByRole('textbox', { name: 'Edit Status for Alpha' });
    fireEvent.change(editor, { target: { value: 'blocked' } });

    // Clicking another cell: the focus transfer fires the editor's blur first, then the cell's
    // own handler runs - the settled flag is what keeps that from being two commits.
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: 'Status for Beta, done' }));

    expect(writes).toEqual([{ itemId: 'item-a', bag: { status: 'blocked' } }]);
    expect(screen.queryByRole('textbox')).toBeNull();
    await Promise.resolve();
  });

  it('says the list is partial when the container was truncated by paging', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA], truncated: true }));

    expect(screen.getByText(/Only the first 2 items in here are loaded\./)).toBeInTheDocument();
  });

  it('offers the keyboard model somewhere a sighted visitor can find it', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    expect(screen.getByText('Keyboard')).toBeInTheDocument();
    // Twice by design: once in the sr-only hint, once in the visible disclosure.
    expect(screen.getAllByText(/fills down/).length).toBeGreaterThanOrEqual(2);
  });
});
