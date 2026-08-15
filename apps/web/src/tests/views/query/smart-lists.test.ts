import { describe, expect, it, vi } from 'vitest';

import {
  SMART_LISTS,
  applySmartList,
  findSmartList,
  smartListView,
  type SmartListPreset,
} from '../../../views/query/smart-lists';

/** The preset at a position, checked - so a reordered registry fails here by name. */
function presetAt(index: number): SmartListPreset {
  const preset = SMART_LISTS[index];
  if (preset === undefined) {
    throw new Error(`No smart-list preset at position ${String(index)}.`);
  }
  return preset;
}

/**
 * The shipped smart-list presets: what each one filters on, and what applying one stores. The
 * keys are conventions until task semantics ship, and the registry's own doc says so - these
 * tests pin the rules so a preset cannot drift from its sentence.
 */

describe('the presets', () => {
  it('offers Today, Next 7 days and Overdue, and no assignment preset before principals exist', () => {
    expect(SMART_LISTS.map((preset) => preset.id)).toEqual(['today', 'next-seven-days', 'overdue']);
  });

  it('spells Overdue as past due AND not done, with absence counting as not done', () => {
    expect(findSmartList('overdue')?.filters).toEqual([
      { property: 'due', operator: 'before', value: 'today' },
      { property: 'done', operator: 'not-equals', value: 'true' },
    ]);
  });

  it('stores one query view that opens by default', () => {
    const view = smartListView(presetAt(0));

    expect(view.kind).toBe('query');
    expect(view.id).toBe('query');
    expect(view.filters).toEqual(presetAt(0).filters);
  });
});

describe('applying a preset', () => {
  it('puts the view set with the query view as the default', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        calls.push({
          url: typeof input === 'string' ? input : input.href,
          body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown,
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );

    const refusal = await applySmartList('item-1', presetAt(2), () => Promise.resolve(null));

    expect(refusal).toBeNull();
    const call = calls[0];
    if (call === undefined) {
      throw new Error('No views request was made.');
    }
    expect(call.url).toBe('/api/v1/items/item-1/views');
    expect(call.body).toMatchObject({
      default: 'query',
      views: [{ kind: 'query', name: 'Overdue' }],
    });
  });

  it('answers with a sentence when the views could not be stored, naming the way out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: "'Overdue': 'x' is not a filter operator." }), {
            status: 422,
          }),
        ),
      ),
    );

    const refusal = await applySmartList('item-1', presetAt(2), () => Promise.resolve(null));

    expect(refusal).toBe("'Overdue': 'x' is not a filter operator.");
  });

  it('answers with a sentence when the request never reached the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    const refusal = await applySmartList('item-1', presetAt(2), () => Promise.resolve(null));

    expect(refusal).toContain('Configure them under Views');
  });
});
