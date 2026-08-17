import { PRINT_PALETTE } from '@nix/design-tokens/print';
import type { SchemaSnapshot, ViewSnapshot } from '@nix/export';
import { describe, expect, it } from 'vitest';

import { DRAWN_VIEW_KINDS, renderView } from './render.js';
import { ROW_CEILING } from './kinds.js';
import type { ViewRow } from './types.js';

/**
 * Views, drawn.
 *
 * **Assertions are on the markup, not on pixels.** A rendered image compared byte for byte would go
 * red on any rasteriser or font change with nothing actually wrong, and would tell nobody what
 * broke. What is checked is that the content reached the drawing, that it is escaped, and that what
 * a drawing cannot show is reported rather than quietly missing.
 */

function view(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  return {
    id: 'view-1',
    name: 'By status',
    kind: 'list',
    columns: ['status'],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    ...overrides,
  };
}

const SCHEMA: SchemaSnapshot = {
  properties: [
    { key: 'status', label: 'Status', type: 'select', options: ['Todo', 'Done'], required: false },
    { key: 'due', label: 'Due', type: 'date', options: [], required: false },
    { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
  ],
  declared: [],
  inherit: true,
};

function row(title: string, properties: Record<string, unknown> = {}): ViewRow {
  return { id: `id-${title}`, title, properties };
}

function draw(kind: string, rows: readonly ViewRow[], overrides: Partial<ViewSnapshot> = {}) {
  return renderView({
    view: view({ kind, ...overrides }),
    rows,
    schema: SCHEMA,
    palette: PRINT_PALETTE,
    width: 480,
  });
}

describe('drawing any view', () => {
  it('draws every kind the interface offers', () => {
    expect([...DRAWN_VIEW_KINDS].sort()).toEqual([
      'board',
      'calendar',
      'form',
      'gallery',
      'interactive_form',
      'list',
      'query',
      'sheet',
      'timeline',
    ]);
  });

  it('produces an SVG document of the width it was given', () => {
    const drawn = draw('list', [row('First')]);

    expect(drawn.svg).toMatch(/^<svg /);
    expect(drawn.svg).toContain('width="480"');
    expect(drawn.width).toBe(480);
    expect(drawn.height).toBeGreaterThan(0);
  });

  it('escapes what came out of a document, so one title cannot break the picture', () => {
    // An unescaped ampersand makes the whole drawing unparseable, which in a rasteriser is a blank
    // rectangle rather than an error anybody sees.
    const drawn = draw('list', [row('Fish & Chips <script>')]);

    expect(drawn.svg).toContain('Fish &amp; Chips &lt;script&gt;');
    expect(drawn.svg).not.toContain('<script>');
  });

  it('draws a frame for a view with nothing in it rather than nothing at all', () => {
    const drawn = draw('board', []);

    expect(drawn.height).toBeGreaterThan(0);
    expect(drawn.svg).toMatch(/^<svg /);
  });

  it('draws a kind it has never heard of as a list, and says so', () => {
    const drawn = draw('gantt', [row('First')]);

    expect(drawn.notes.join(' ')).toContain('drawn as a list');
    expect(drawn.svg).toContain('First');
  });

  it('says when it drew fewer rows than the view holds', () => {
    const many = Array.from({ length: ROW_CEILING + 5 }, (_unused, index) =>
      row(`Item ${String(index)}`),
    );

    const drawn = draw('list', many);

    expect(drawn.notes.join(' ')).toContain(String(ROW_CEILING + 5));
  });
});

describe('a list', () => {
  it('draws a header from the schema labels and a row per item', () => {
    const drawn = draw('list', [row('Ship it', { status: 'Done' })]);

    expect(drawn.svg).toContain('Title');
    expect(drawn.svg).toContain('Status');
    expect(drawn.svg).toContain('Ship it');
    expect(drawn.svg).toContain('Done');
  });

  it('shows a checkbox in ASCII, which survives a font with no symbols', () => {
    const drawn = renderView({
      view: view({ kind: 'list', columns: ['done'] }),
      rows: [row('Task', { done: true })],
      schema: SCHEMA,
      palette: PRINT_PALETTE,
      width: 480,
    });

    expect(drawn.svg).toContain('[x]');
  });
});

describe('forms', () => {
  it('draws a quick form as fields rather than response rows', () => {
    const drawn = draw('form', [row('An existing response')], { columns: ['status', 'due'] });

    expect(drawn.svg).toContain('New response');
    expect(drawn.svg).toContain('Status');
    expect(drawn.svg).toContain('Due');
    expect(drawn.svg).toContain('Add response');
    expect(drawn.svg).not.toContain('An existing response');
    expect(drawn.notes).toEqual([]);
  });

  it('draws the configured Interactive Form page and prompts', () => {
    const drawn = draw('interactive_form', [], {
      interactiveForm: {
        pages: [
          {
            id: 'page-1',
            title: 'Daily check-in',
            description: 'Tell us how today went.',
            visibleWhen: [],
            blocks: [
              {
                id: 'heading-1',
                kind: 'heading',
                propertyKey: null,
                text: 'Your day',
                help: null,
                required: false,
                identityRole: null,
                visibleWhen: [],
              },
              {
                id: 'field-1',
                kind: 'field',
                propertyKey: 'status',
                text: 'How did it go?',
                help: null,
                required: true,
                identityRole: null,
                visibleWhen: [],
              },
            ],
          },
        ],
        titleMode: 'generated',
        titleFieldBlockId: null,
        confirmationTitle: 'Thank you',
        confirmationMessage: 'Saved.',
      },
    });

    expect(drawn.svg).toContain('Daily check-in');
    expect(drawn.svg).toContain('Your day');
    expect(drawn.svg).toContain('How did it go? *');
    expect(drawn.svg).toContain('Submit');
    expect(drawn.notes).toEqual([]);
  });
});

describe('a board', () => {
  it('draws a column per group, in the order the view stored', () => {
    const drawn = draw('board', [row('A', { status: 'Todo' }), row('B', { status: 'Done' })], {
      groupBy: 'status',
      groupOrder: ['Done', 'Todo'],
    });

    const done = drawn.svg.indexOf('Done (1)');
    const todo = drawn.svg.indexOf('Todo (1)');

    expect(done).toBeGreaterThan(-1);
    expect(todo).toBeGreaterThan(done);
  });

  it('keeps cards whose group value is unset rather than dropping them', () => {
    // The interface shows these; a picture holding fewer cards than the board would be a difference
    // nobody notices until it matters.
    const drawn = draw('board', [row('Loose')], { groupBy: 'status' });

    expect(drawn.svg).toContain('No value');
    expect(drawn.svg).toContain('Loose');
  });
});

describe('a gallery', () => {
  it('says the covers are not in the file rather than drawing empty tiles silently', () => {
    const drawn = draw('gallery', [row('Cover me')], { coverProperty: 'image' });

    expect(drawn.notes.join(' ')).toContain('without its cover pictures');
    expect(drawn.svg).toContain('Cover not included');
  });
});

describe('a calendar', () => {
  it('places an item on the day its date property names', () => {
    const drawn = draw('calendar', [row('Review', { due: '2026-08-12' })], {
      dateProperty: 'due',
    });

    expect(drawn.svg).toContain('Review');
    expect(drawn.svg).toContain('Mon');
  });

  it('says so when nothing inside carries the date it reads', () => {
    const drawn = draw('calendar', [row('Undated')], { dateProperty: 'due' });

    expect(drawn.notes.join(' ')).toContain('nothing inside it carries the date');
  });
});

describe('a timeline', () => {
  it('draws a bar between the dates it was given', () => {
    const drawn = draw(
      'timeline',
      [
        row('Phase one', { due: '2026-08-01', end: '2026-08-10' }),
        row('Phase two', { due: '2026-08-11', end: '2026-08-20' }),
      ],
      { dateProperty: 'due', endDateProperty: 'end' },
    );

    expect(drawn.svg).toContain('Phase one');
    expect(drawn.svg).toContain('2026-08-01');
    // A bar per dated row, plus the header band.
    expect(drawn.svg.match(/<rect /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('draws the labels even when nothing carries a date', () => {
    const drawn = draw('timeline', [row('Undated')], { dateProperty: 'due' });

    expect(drawn.svg).toContain('Undated');
    expect(drawn.svg).toContain('No dates');
  });
});

describe('the month a calendar draws', () => {
  it('numbers only the days the month actually has', () => {
    // An earlier cut drew a plain 5x7 grid numbered 1 to 35 and printed days 32 to 35, which a
    // reader would take for dates. August 2026 has 31.
    const drawn = draw('calendar', [row('Review', { due: '2026-08-12' })], {
      dateProperty: 'due',
    });

    expect(drawn.svg).toContain('>31<');
    expect(drawn.svg).not.toContain('>32<');
    expect(drawn.svg).not.toContain('>35<');
  });

  it('starts the month on the weekday it really starts on', () => {
    // 1 August 2026 is a Saturday, so the first five cells of the grid are empty.
    const drawn = draw('calendar', [row('Review', { due: '2026-08-12' })], {
      dateProperty: 'due',
    });

    expect(drawn.svg).toContain('2026-08');
    const firstDay = drawn.svg.indexOf('>1<');
    const secondDay = drawn.svg.indexOf('>2<');
    expect(firstDay).toBeGreaterThan(-1);
    expect(secondDay).toBeGreaterThan(firstDay);
  });
});

describe('the bar a timeline draws', () => {
  it('draws one for the item on the last date, which used to get none', () => {
    // The last date sits at the full track width, so clipping the bar to the track gave the
    // longest-running item a width of zero.
    const drawn = draw(
      'timeline',
      [row('First', { due: '2026-08-01' }), row('Last', { due: '2026-08-24' })],
      { dateProperty: 'due' },
    );

    const bars =
      drawn.svg.match(new RegExp(`<rect [^>]*fill="${PRINT_PALETTE.accentFill}"[^>]*/>`, 'g')) ??
      [];

    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      const width = Number(/width="([\d.]+)"/.exec(bar)?.[1] ?? '0');
      expect(width).toBeGreaterThan(0);
    }
  });
});
