import type {
  InteractiveFormDefinition,
  PropertyDefinition,
  View,
  ViewFilterRule,
} from '../core/container-model';
import { SMART_LISTS } from '../query/smart-lists';

export type StructuredRecipeId =
  | 'board'
  | 'calendar'
  | 'timeline'
  | 'gallery'
  | 'sheet'
  | 'form'
  | 'interactive-form'
  | 'query'
  | 'list';

export interface StructuredRecipe {
  readonly id: StructuredRecipeId;
  readonly label: string;
  readonly detail: string;
  readonly menu: 'structured' | 'view';
  readonly viewKind: string;
  readonly defaultTitle: string;
  readonly defaultViewName: string;
  readonly properties: readonly PropertyDefinition[];
  readonly filters?: readonly ViewFilterRule[];
}

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};

const STARTS: PropertyDefinition = {
  key: 'starts',
  label: 'Starts',
  type: 'timestamp',
  options: [],
  required: false,
};

export const STRUCTURED_RECIPES: readonly StructuredRecipe[] = [
  {
    id: 'board',
    label: 'Board',
    detail: 'Arrange items in columns defined by a select field.',
    menu: 'structured',
    viewKind: 'board',
    defaultTitle: 'Untitled board',
    defaultViewName: 'Board',
    properties: [STATUS],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    detail: 'Plan work across start and optional end dates.',
    menu: 'structured',
    viewKind: 'timeline',
    defaultTitle: 'Untitled timeline',
    defaultViewName: 'Timeline',
    properties: [
      STARTS,
      { key: 'ends', label: 'Ends', type: 'timestamp', options: [], required: false },
    ],
  },
  {
    id: 'gallery',
    label: 'Gallery',
    detail: 'Show child items as visual cards with optional covers.',
    menu: 'structured',
    viewKind: 'gallery',
    defaultTitle: 'Untitled gallery',
    defaultViewName: 'Gallery',
    properties: [{ key: 'cover', label: 'Cover', type: 'image', options: [], required: false }],
  },
  {
    id: 'sheet',
    label: 'Spreadsheet view',
    detail: 'Edit child items in a property-backed grid.',
    menu: 'structured',
    viewKind: 'sheet',
    defaultTitle: 'Untitled table',
    defaultViewName: 'Spreadsheet',
    properties: [
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: ['Open', 'Done'],
        required: false,
      },
      { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
    ],
  },
  {
    id: 'form',
    label: 'Quick form',
    detail: 'Collect authenticated responses in one straightforward page.',
    menu: 'structured',
    viewKind: 'form',
    defaultTitle: 'Untitled quick form',
    defaultViewName: 'Form',
    properties: [{ key: 'response', label: 'Response', type: 'text', options: [], required: true }],
  },
  {
    id: 'interactive-form',
    label: 'Interactive form',
    detail: 'Build a multi-page form with branching and an optional public link.',
    menu: 'structured',
    viewKind: 'interactive_form',
    defaultTitle: 'Untitled interactive form',
    defaultViewName: 'Form',
    properties: [
      { key: 'response', label: 'Response', type: 'text', options: [], required: false },
    ],
  },
  {
    id: 'query',
    label: 'Smart list',
    detail: 'Find matching items across the workspace with reusable rules.',
    menu: 'structured',
    viewKind: 'query',
    defaultTitle: 'Untitled smart list',
    defaultViewName: 'Results',
    properties: [],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    detail: 'Place child items on a day, week, or month calendar.',
    menu: 'view',
    viewKind: 'calendar',
    defaultTitle: 'Untitled calendar',
    defaultViewName: 'Calendar',
    properties: [STARTS],
  },
  {
    id: 'list',
    label: 'List',
    detail: 'Show child items and their fields in an ordered list.',
    menu: 'view',
    viewKind: 'list',
    defaultTitle: 'Untitled list',
    defaultViewName: 'All',
    properties: [
      { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
      { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
    ],
  },
];

export function findStructuredRecipe(id: string | undefined): StructuredRecipe | null {
  return STRUCTURED_RECIPES.find((recipe) => recipe.id === id) ?? null;
}

export function keyForProperty(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  );
}

export function defaultInteractiveForm(
  property: PropertyDefinition = {
    key: 'response',
    label: 'Response',
    type: 'text',
    options: [],
    required: false,
  },
): InteractiveFormDefinition {
  return {
    pages: [
      {
        id: 'page-1',
        title: 'Your response',
        description: null,
        visibleWhen: [],
        blocks: [
          {
            id: 'field-response',
            kind: 'field',
            propertyKey: property.key,
            text: property.label,
            help: null,
            required: property.required,
            identityRole: null,
            visibleWhen: [],
          },
        ],
      },
    ],
    titleMode: 'generated',
    titleFieldBlockId: null,
    confirmationTitle: 'Response received',
    confirmationMessage: 'Your response has been added.',
  };
}

export function viewForRecipe(
  recipe: StructuredRecipe,
  properties: readonly PropertyDefinition[],
): View {
  const first = properties[0];
  const second = properties[1];
  const id = recipe.viewKind === 'interactive_form' ? 'form' : recipe.viewKind;
  return {
    id,
    name: recipe.defaultViewName,
    kind: recipe.viewKind,
    columns: ['title', ...properties.map((property) => property.key)],
    groupBy: recipe.viewKind === 'board' ? (first?.key ?? null) : null,
    groupOrder: recipe.viewKind === 'board' ? [...(first?.options ?? [])] : [],
    dateProperty:
      recipe.viewKind === 'calendar' || recipe.viewKind === 'timeline'
        ? (first?.key ?? null)
        : null,
    sortBy: null,
    sortDescending: false,
    mode: recipe.viewKind === 'calendar' ? 'week' : recipe.viewKind === 'timeline' ? 'month' : null,
    coverProperty: recipe.viewKind === 'gallery' ? (first?.key ?? null) : null,
    endDateProperty: recipe.viewKind === 'timeline' ? (second?.key ?? null) : null,
    cardSize: recipe.viewKind === 'gallery' ? 'medium' : null,
    filters: [...(recipe.filters ?? [])],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: recipe.viewKind === 'interactive_form' ? defaultInteractiveForm(first) : null,
  };
}

/**
 * The Smart list wizard's date/assignment shortcuts, reusing the shipped presets in
 * `views/query/smart-lists.ts` rather than restating their rules - the wizard's shortcut and the
 * "apply to an existing item" preset must name the same reserved keys (ADR-0042), so one registry
 * is the source and the other re-exports it instead of drifting a second copy.
 */
export const SMART_LIST_STARTERS: readonly {
  readonly id: string;
  readonly label: string;
  readonly filters: readonly ViewFilterRule[];
}[] = SMART_LISTS;
