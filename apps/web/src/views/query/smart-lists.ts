import type { View, ViewFilterRule } from '../core/container-model';

/**
 * The shipped smart-list starting points - a registry in the `templates.ts` shape (ADR-0014):
 * presets this build offers, not user-saved artifacts. Applying one creates an item of type
 * `query` and stores a single query view on it; from there it is an ordinary item whose filters
 * are edited like any view configuration.
 *
 * **The property keys are conventions, and say so.** `due` (a date) and `done` (a checkbox) are
 * what the presets filter on until goal 3.1 ships task semantics as first-class property types;
 * when it does, these follow its canonical keys. A workspace whose containers use other keys
 * edits the filters after applying - the preset is a starting point, not a schema.
 *
 * **Assigned-to-me is deliberately absent.** It needs 3.5's principal-typed property; a preset
 * filtering on a convention key for *identity* would silently show the wrong person's work, which
 * is a worse failure than the preset not existing.
 */

export interface SmartListPreset {
  readonly id: string;
  readonly label: string;

  /** What the preset is for, shown beside the label wherever it is offered. */
  readonly detail: string;

  /** The item's own title once created. */
  readonly title: string;

  readonly filters: readonly ViewFilterRule[];
}

export const SMART_LISTS: readonly SmartListPreset[] = [
  {
    id: 'today',
    label: 'Today',
    detail: 'Everything due today, wherever it lives.',
    title: 'Today',
    filters: [{ property: 'due', operator: 'on', value: 'today' }],
  },
  {
    id: 'next-seven-days',
    label: 'Next 7 days',
    detail: 'Everything due within a week, today included.',
    title: 'Next 7 days',
    filters: [{ property: 'due', operator: 'within-next', value: '7' }],
  },
  {
    id: 'overdue',
    label: 'Overdue',
    detail: 'Everything past due and not done.',
    title: 'Overdue',
    filters: [
      { property: 'due', operator: 'before', value: 'today' },
      { property: 'done', operator: 'not-equals', value: 'true' },
    ],
  },
];

export function findSmartList(id: string): SmartListPreset | null {
  return SMART_LISTS.find((preset) => preset.id === id) ?? null;
}

/**
 * Stores a preset's query view on a freshly created item, so opening it lands on the results.
 *
 * Raw `fetch` with a bearer token, the same acknowledged tech debt `use-container.ts` carries and
 * for the same reason; both move together when the client's cache layer is wired. Returns the
 * refusal, or null when stored - an item created but left without its view is still a working
 * item whose view can be added by hand, which is why the caller reports rather than rolls back.
 */
export async function applySmartList(
  itemId: string,
  preset: SmartListPreset,
  getAccessToken: () => Promise<string | null>,
): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const response = await fetch(`/api/v1/items/${itemId}/views`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ views: [smartListView(preset)], default: 'query' }),
    });

    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
      return problem?.detail ?? 'The smart list was created but its filters could not be saved.';
    }

    return null;
  } catch {
    return 'The smart list was created but its filters could not be sent. Configure them under Views.';
  }
}

/** The one query view a preset stores, with the view opening by default. */
export function smartListView(preset: SmartListPreset): View {
  return {
    id: 'query',
    name: preset.label,
    kind: 'query',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    filters: [...preset.filters],
  };
}
