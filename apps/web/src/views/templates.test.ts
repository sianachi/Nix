import { describe, expect, it, vi } from 'vitest';

import { aContainer, views as viewsOf } from './container-fixture';
import type { PropertyDefinition, View } from './container-model';
import { TEMPLATES, applyTemplate, findTemplate, type Template } from './templates';

/**
 * The ready-made setups.
 *
 * Two things are worth holding here. The order of the two writes, because the server deliberately
 * does not check that a view's property exists and views-first would store a board that reports
 * itself broken until the schema catches up. And that applying one *merges*, because both writes
 * replace wholesale and a template that overwrote what somebody had already declared would be a
 * one-click way to lose work.
 */

function containerWith(
  declared: readonly PropertyDefinition[] = [],
  offered: readonly View[] = [],
): {
  container: ReturnType<typeof aContainer>;
  calls: string[];
  setSchema: ReturnType<typeof vi.fn>;
  setViews: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];

  const setSchema = vi.fn(() => {
    calls.push('schema');
    return Promise.resolve(null);
  });

  const setViews = vi.fn(() => {
    calls.push('views');
    return Promise.resolve(null);
  });

  const container = aContainer({
    schema: { properties: [...declared], declared: [...declared], inherit: true },
    views: viewsOf(offered),
    setSchema,
    setViews,
  });

  return { container, calls, setSchema, setViews };
}

/**
 * Finds a template that is expected to exist.
 *
 * A `!` would turn a renamed template into "cannot read properties of null" inside `applyTemplate`,
 * several frames from the test that meant to name it.
 */
function template(id: string): Template {
  const found = findTemplate(id);
  if (found === null) {
    throw new Error(`No template called "${id}".`);
  }

  return found;
}

describe('the templates on offer', () => {
  it('each declare what their views need', () => {
    // A board must name a property to group by and a calendar a property to place by, or the
    // server refuses the view. A template that shipped one without the other would fail on the
    // second of its two writes, having already made the first.
    for (const template of TEMPLATES) {
      for (const view of template.views) {
        const needed = view.groupBy ?? view.dateProperty;
        if (needed !== null) {
          expect(template.properties.map((property) => property.key)).toContain(needed);
        }
      }
    }
  });

  it('give every select something to select from', () => {
    // The server refuses a select with no options: it is a board with no columns.
    for (const template of TEMPLATES) {
      for (const property of template.properties) {
        if (property.type === 'select' || property.type === 'multi_select') {
          expect(property.options.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never claim the reserved view id', () => {
    for (const template of TEMPLATES) {
      expect(template.views.map((view) => view.id)).not.toContain('document');
    }
  });

  it('open on a view they actually ship', () => {
    // The server refuses a default naming a view the same request does not contain.
    for (const template of TEMPLATES) {
      if (template.opensOn !== null) {
        expect(template.views.map((view) => view.id)).toContain(template.opensOn);
      }
    }
  });
});

describe('applying one', () => {
  it('writes the schema before the views', async () => {
    const { container, calls } = containerWith();

    await applyTemplate(template('kanban'), container);

    // The server does not check that a view's grouping property exists, so views-first would store
    // a board that reports itself unrenderable until the schema landed - a broken state on screen
    // for no gain.
    expect(calls).toEqual(['schema', 'views']);
  });

  it('opens the item on the view it just made', async () => {
    const { container, setViews } = containerWith();

    await applyTemplate(template('kanban'), container);

    // Without this the item still opens on its document, and a one-click "set up a board" looks
    // like it did nothing.
    expect(setViews).toHaveBeenCalledWith(expect.anything(), 'board');
  });

  it('keeps what the item already declared', async () => {
    const owner: PropertyDefinition = {
      key: 'owner',
      label: 'Owner',
      type: 'text',
      options: [],
      required: false,
    };

    const { container, setSchema } = containerWith([owner]);

    await applyTemplate(template('kanban'), container);

    // `setSchema` replaces wholesale. A template that sent only its own properties would be a
    // one-click way to delete somebody's schema.
    const draft = setSchema.mock.calls[0]?.[0] as { properties: PropertyDefinition[] };
    expect(draft.properties.map((property) => property.key)).toEqual(['owner', 'status']);
  });

  it('keeps what the item already offered', async () => {
    const existing: View = {
      id: 'all',
      name: 'Everything',
      kind: 'list',
      columns: [],
      groupBy: null,
      groupOrder: [],
      dateProperty: null,
      sortBy: null,
      sortDescending: false,
      mode: null,
    };

    const { container, setViews } = containerWith([], [existing]);

    await applyTemplate(template('kanban'), container);

    const sent = setViews.mock.calls[0]?.[0] as View[];
    expect(sent.map((view) => view.id)).toEqual(['all', 'board']);
  });

  it('changes nothing when applied twice', async () => {
    const kanban = template('kanban');
    const { container, setSchema, setViews } = containerWith(
      [...kanban.properties],
      [...kanban.views],
    );

    await applyTemplate(kanban, container);

    // Neither a second Status nor a second board. What is already there wins, so a template never
    // overwrites an option list somebody has edited.
    const draft = setSchema.mock.calls[0]?.[0] as { properties: PropertyDefinition[] };
    const sent = setViews.mock.calls[0]?.[0] as View[];

    expect(draft.properties).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('stops at the schema when the schema is refused', async () => {
    const setViews = vi.fn(() => Promise.resolve(null));
    const container = aContainer({
      schema: { properties: [], declared: [], inherit: true },
      views: viewsOf([]),
      setSchema: () => Promise.resolve('That property key is already taken.'),
      setViews,
    });

    const refusal = await applyTemplate(template('kanban'), container);

    // Carrying on would offer a board grouping by a property that was never declared.
    expect(refusal).toBe('That property key is already taken.');
    expect(setViews).not.toHaveBeenCalled();
  });
});
