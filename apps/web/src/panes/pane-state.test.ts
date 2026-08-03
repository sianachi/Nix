import { describe, expect, it, vi } from 'vitest';

import { clearViewState, parseFilters, parseViewState } from '../views/view-state';
import { closePaneParams, parsePanes } from './pane-state';
import {
  PANE_LIMIT,
  paneFilterPrefix,
  paneParam,
  parseSizes,
  parseSplit,
  sizesToParam,
} from './pane-params';

/**
 * The arrangement, read out of a query string.
 *
 * The parsers rather than the hook, so they run without a router. What they protect is the claim
 * the URL grammar makes: a link reproduces the arrangement its sender was looking at, and pane one
 * still means what it meant before panes existed.
 */

describe('the parameter names', () => {
  it('leaves the first pane exactly as it was', () => {
    // The compatibility promise. Every link anybody has been sent addresses these names, and a
    // suffix on the first pane would have broken all of them at once.
    expect(paneParam('item', 0)).toBe('item');
    expect(paneParam('view', 0)).toBe('view');
    expect(paneFilterPrefix(0)).toBe('f.');
  });

  it('gives later panes a one-based suffix', () => {
    expect(paneParam('item', 1)).toBe('item2');
    expect(paneParam('view', 2)).toBe('view3');
    expect(paneFilterPrefix(1)).toBe('f2.');
  });

  it('keeps one pane’s filters from matching another’s prefix', () => {
    // Why the second pane is `f2.` and not `f.2.`: the existing reader is a single `startsWith`,
    // and it has to separate the panes rather than see one as a prefix of the other.
    expect(paneFilterPrefix(1).startsWith(paneFilterPrefix(0))).toBe(false);
    expect(paneFilterPrefix(0).startsWith(paneFilterPrefix(1))).toBe(false);
  });
});

describe('reading an arrangement', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const third = '00000000-0000-4000-8000-000000000003';

  it('reads one pane from the address every existing link uses', () => {
    const { panes, split, sizes } = parsePanes(new URLSearchParams(`item=${first}`));

    expect(panes).toEqual([{ index: 0, itemId: first }]);
    expect(split).toBe('vertical');
    expect(sizes).toBeNull();
  });

  it('reads several panes in order', () => {
    const { panes } = parsePanes(
      new URLSearchParams(`item=${first}&item2=${second}&item3=${third}`),
    );

    expect(panes.map((pane) => pane.itemId)).toEqual([first, second, third]);
  });

  it('reads nothing when nothing is open', () => {
    expect(parsePanes(new URLSearchParams()).panes).toEqual([]);
  });

  it('stops at a gap rather than renumbering around it', () => {
    // `item3` with no `item2` describes an arrangement that cannot exist - a truncated or
    // hand-edited link. Closing the gap would open something the sender did not send.
    const { panes } = parsePanes(new URLSearchParams(`item=${first}&item3=${third}`));

    expect(panes.map((pane) => pane.itemId)).toEqual([first]);
  });

  it('drops a pane past the limit, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const query = [`item=${first}`, `item2=${second}`, `item3=${third}`, `item4=${first}`].join(
      '&',
    );
    const { panes } = parsePanes(new URLSearchParams(query));

    expect(panes).toHaveLength(PANE_LIMIT);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops a pane whose identifier is not one, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { panes } = parsePanes(new URLSearchParams(`item=${first}&item2=not-a-uuid`));

    expect(panes.map((pane) => pane.itemId)).toEqual([first]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('each pane’s view state', () => {
  it('reads only its own pane’s parameters', () => {
    const params = new URLSearchParams(
      'view=board&sort=owner&f.status=open&view2=calendar&sort2=due&f2.status=done',
    );

    expect(parseViewState(params, 0)).toMatchObject({ viewId: 'board', sortBy: 'owner' });
    expect(parseViewState(params, 1)).toMatchObject({ viewId: 'calendar', sortBy: 'due' });
    expect(parseFilters(params, 0)).toEqual([{ propertyKey: 'status', values: ['open'] }]);
    expect(parseFilters(params, 1)).toEqual([{ propertyKey: 'status', values: ['done'] }]);
  });

  it('reads nothing for a pane the address says nothing about', () => {
    const params = new URLSearchParams('view=board&sort=owner&f.status=open');

    expect(parseViewState(params, 1)).toMatchObject({ viewId: null, sortBy: null, filters: [] });
  });
});

describe('clearing one pane’s view state', () => {
  it('leaves every other pane untouched', () => {
    // The defect this whole refactor exists to prevent, and the one a naive port would have
    // shipped: `clearViewState` deleted the unprefixed names unconditionally, so navigating in
    // the second pane would silently discard the first pane's board, its sort and its filters -
    // a change to a part of the screen the person was not looking at.
    const params = new URLSearchParams(
      'view=board&sort=owner&dir=descending&f.status=open&view2=calendar&sort2=due&f2.status=done',
    );

    clearViewState(params, 1);

    expect(params.get('view')).toBe('board');
    expect(params.get('sort')).toBe('owner');
    expect(params.get('dir')).toBe('descending');
    expect(params.getAll('f.status')).toEqual(['open']);

    expect(params.get('view2')).toBeNull();
    expect(params.get('sort2')).toBeNull();
    expect(params.getAll('f2.status')).toEqual([]);
  });

  it('clears the first pane without touching the second', () => {
    const params = new URLSearchParams('view=board&f.status=open&view2=calendar&f2.status=done');

    clearViewState(params, 0);

    expect(params.get('view')).toBeNull();
    expect(params.getAll('f.status')).toEqual([]);
    expect(params.get('view2')).toBe('calendar');
    expect(params.getAll('f2.status')).toEqual(['done']);
  });

  it('defaults to the first pane, so every existing caller is unchanged', () => {
    const params = new URLSearchParams('view=board&f.status=open');

    clearViewState(params);

    expect(params.get('view')).toBeNull();
    expect(params.getAll('f.status')).toEqual([]);
  });
});

describe('the split orientation', () => {
  it('reads both spellings', () => {
    expect(parseSplit('h')).toBe('horizontal');
    expect(parseSplit('horizontal')).toBe('horizontal');
    expect(parseSplit('v')).toBe('vertical');
  });

  it('defaults when the address names none', () => {
    expect(parseSplit(null)).toBe('vertical');
  });

  it('falls back and says so when the address names something else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseSplit('diagonal')).toBe('vertical');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the pane ratio', () => {
  it('reads one percentage per pane', () => {
    expect(parseSizes('62.5,37.5', 2)).toEqual([62.5, 37.5]);
  });

  it('is absent when the address says nothing', () => {
    expect(parseSizes(null, 2)).toBeNull();
  });

  it('discards a ratio that describes a different number of panes', () => {
    // Rescaling a two-pane ratio onto three would be inventing a layout nobody chose, and
    // guessing which two of the three it described is not something a reader should have to do.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseSizes('60,40', 3)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('discards a ratio with a value that is not a positive number', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseSizes('60,-10', 2)).toBeNull();
    expect(parseSizes('60,wide', 2)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('writes a ratio a person can read', () => {
    // A drag produces a float with a dozen decimal places, and none of them belong in a link.
    expect(sizesToParam([62.54321, 37.45679])).toBe('62.5,37.5');
  });

  it('round-trips what it writes', () => {
    const sizes = [62.5, 37.5];
    expect(parseSizes(sizesToParam(sizes), 2)).toEqual(sizes);
  });
});

describe('closing a pane', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const third = '00000000-0000-4000-8000-000000000003';

  function arrangementOf(query: string): string[] {
    return parsePanes(new URLSearchParams(query)).panes.map((pane) => pane.itemId);
  }

  it('closes the last pane and leaves the rest alone', () => {
    const params = new URLSearchParams(`item=${first}&view=board&item2=${second}&view2=calendar`);

    closePaneParams(params, 1, 2);

    expect(arrangementOf(params.toString())).toEqual([first]);
    expect(params.get('view')).toBe('board');
    expect(params.get('view2')).toBeNull();
  });

  it('renumbers the panes after the one that closed', () => {
    // The failure this guards: leave `item` and `item3` behind and `parsePanes` stops at the gap,
    // so closing the middle pane would take the third one with it.
    const params = new URLSearchParams(
      `item=${first}&item2=${second}&item3=${third}&view3=calendar&f3.status=done`,
    );

    closePaneParams(params, 1, 3);

    expect(arrangementOf(params.toString())).toEqual([first, third]);
    // The third pane's whole state moves down with it, not just its item.
    expect(params.get('view2')).toBe('calendar');
    expect(params.getAll('f2.status')).toEqual(['done']);
    expect(params.get('view3')).toBeNull();
    expect(params.get('item3')).toBeNull();
  });

  it('carries a pane’s filters down without merging them into the pane below', () => {
    const params = new URLSearchParams(
      `item=${first}&f.status=open&item2=${second}&f2.status=done&item3=${third}&f3.owner=ada`,
    );

    closePaneParams(params, 1, 3);

    expect(params.getAll('f.status')).toEqual(['open']);
    expect(params.getAll('f2.owner')).toEqual(['ada']);
    expect(params.getAll('f2.status')).toEqual([]);
  });

  it('drops a ratio that no longer describes the panes', () => {
    const params = new URLSearchParams(`item=${first}&item2=${second}&sizes=60,40`);

    closePaneParams(params, 1, 2);

    expect(params.get('sizes')).toBeNull();
  });
});
