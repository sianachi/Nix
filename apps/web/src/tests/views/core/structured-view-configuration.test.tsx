import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { PropertyDefinition, View } from '../../../views/core/container-model';
import { StructuredViewConfiguration } from '../../../views/core/structured-view-configuration';
import { aView } from '../../view-fixture';

const FIELDS: readonly PropertyDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['Planned', 'Done'],
    required: false,
  },
  {
    key: 'priority',
    label: 'Priority',
    type: 'select',
    options: ['High', 'Low'],
    required: false,
  },
];

function BoardConfiguration(): ReactNode {
  const [view, setView] = useState<View>(
    aView({
      kind: 'board',
      groupBy: 'status',
      groupOrder: ['Planned', 'Done'],
      columns: ['title', 'status'],
    }),
  );
  return <StructuredViewConfiguration view={view} fields={FIELDS} onChange={setView} />;
}

describe('shared structured-view configuration', () => {
  it('allows new lines and multiword board columns to be typed', async () => {
    const user = userEvent.setup();
    render(<BoardConfiguration />);
    const order = screen.getByRole('textbox', { name: 'Column order' });
    await user.clear(order);
    await user.type(order, 'To do{Enter}In progress{Enter}Done{Enter}');
    expect(order).toHaveValue('To do\nIn progress\nDone\n');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'priority');
    expect(order).toHaveValue('');
  });

  it('edits configured properties and ordered visible fields through one control surface', async () => {
    const user = userEvent.setup();
    render(<BoardConfiguration />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by' }), 'priority');
    expect(screen.getByRole('combobox', { name: 'Group by' })).toHaveValue('priority');
    expect(screen.getByRole('textbox', { name: 'Column order' })).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Hide Status' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Add visible field' }),
      'priority',
    );

    expect(screen.getByRole('button', { name: 'Hide Priority' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Hide Status' })).not.toBeInTheDocument();
  });
});
