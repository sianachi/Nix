import type { PropertyDefinition } from '../views/core/container-model';
import { PropertyValueDisplay } from './property-value-display';

/**
 * Values as a card or a grid cell shows them: read, never edited.
 */
function property(key: string, label: string, type: string): PropertyDefinition {
  return {
    key,
    label,
    type,
    options: [],
    required: false,
    expression: null,
    aggregate: null,
    source: null,
  };
}

const ITEM = {
  title: 'Launch checklist',
  properties: {
    status: 'Doing',
    tags: ['Design', 'Q3'],
    priority: 1,
    estimate: 3.5,
    due: '2000-01-01',
    done: true,
    link: 'https://example.com/spec',
  },
};

const PROPERTIES = [
  property('status', 'Status', 'select'),
  property('tags', 'Tags', 'multi_select'),
  property('priority', 'Priority', 'priority'),
  property('estimate', 'Estimate', 'estimate'),
  property('due', 'Due', 'due_date'),
  property('done', 'Done', 'checkbox'),
  property('link', 'Spec', 'url'),
];

export default { title: 'Nix/Views/Property value display', parameters: { layout: 'padded' } };

/** Every common type, stacked as a card face would show them. */
export const CardFace = {
  render: () => (
    <div className="flex w-64 flex-col gap-2 p-3">
      {PROPERTIES.map((entry) => (
        <PropertyValueDisplay key={entry.key} item={ITEM} property={entry} />
      ))}
    </div>
  ),
};

/** One line per value, truncating, as a grid cell shows them. */
export const Cells = {
  render: () => (
    <div className="flex w-40 flex-col gap-2 p-3">
      {PROPERTIES.map((entry) => (
        <PropertyValueDisplay key={entry.key} item={ITEM} property={entry} density="cell" />
      ))}
    </div>
  ),
};
