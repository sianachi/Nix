import { describe, expect, it } from 'vitest';

import { compileEditForm } from '../compile/edits.js';
import type { StructureProperty, StructureView } from '../types.js';
import { describeSteps, type DescribeContext } from './steps.js';

const properties: StructureProperty[] = [
  { key: 'name', label: 'Name', type: 'text', options: [], required: false },
  { key: 'email', label: 'Email', type: 'text', options: [], required: false },
  { key: 'status', label: 'Status', type: 'select', options: ['New', 'Done'], required: false },
];

function formView(): StructureView {
  return {
    id: 'form',
    name: 'Contact form',
    kind: 'interactive_form',
    columns: ['title'],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    interactiveForm: {
      pages: [
        {
          id: 'p1',
          title: 'Contact details',
          description: null,
          visibleWhen: [],
          blocks: [
            {
              id: 'b1',
              kind: 'field',
              propertyKey: 'name',
              text: 'Name',
              help: null,
              required: false,
              identityRole: null,
              visibleWhen: [],
            },
            {
              id: 'b2',
              kind: 'field',
              propertyKey: 'email',
              text: 'Email',
              help: null,
              required: false,
              identityRole: null,
              visibleWhen: [],
            },
          ],
        },
      ],
      titleMode: 'generated',
      titleFieldBlockId: null,
      confirmationTitle: 'Thanks',
      confirmationMessage: 'Received',
    },
  };
}

function describeContext(views: StructureView[]): DescribeContext {
  return {
    destination: { title: 'Contacts', path: ['Contacts'] },
    existing: { declared: properties, effective: properties, views },
    problems: [],
    warnings: [],
  };
}

describe('describe edit operations', () => {
  it('names added, removed and reworded questions in the form diff', () => {
    const oldView = formView();
    const [step] = compileEditForm(
      {
        viewId: 'form',
        fields: [{ label: 'Phone', type: 'text' }],
        form: {
          pages: [
            {
              title: 'Contact details',
              blocks: [{ field: 'name', help: 'Use your full name.' }, { field: 'Phone' }],
            },
          ],
        },
      },
      {
        itemId: 'contacts-1',
        existing: { declared: properties, inherit: true, effective: properties, views: [oldView] },
        view: oldView,
      },
    );
    if (step?.kind !== 'replaceViewSetup') throw new Error('expected replaceViewSetup');

    const preview = describeSteps([step], describeContext([oldView]));
    const details = preview.tree.flatMap((page) => page.detail);
    expect(preview.headline).toBe('I will update the interactive form on Contacts.');
    expect(details).toContain('Reworded question: Name');
    expect(details).toContain('Added question: Phone');
    expect(details).toContain('Removed question: Email');
  });

  it('describes changed visibility conditions in plain language', () => {
    const oldView = formView();
    const [step] = compileEditForm(
      {
        viewId: 'form',
        form: {
          pages: [
            {
              title: 'Contact details',
              blocks: [
                { field: 'status' },
                { field: 'name', showWhen: [{ field: 'status', op: 'equals', value: 'Done' }] },
                { field: 'email' },
              ],
            },
          ],
        },
      },
      {
        itemId: 'contacts-1',
        existing: { declared: properties, inherit: true, effective: properties, views: [oldView] },
        view: oldView,
      },
    );
    if (step?.kind !== 'replaceViewSetup') throw new Error('expected replaceViewSetup');

    const preview = describeSteps([step], describeContext([oldView]));
    expect(preview.tree[0]?.detail).toContain('Now shown when Status equals Done.');
  });
});
