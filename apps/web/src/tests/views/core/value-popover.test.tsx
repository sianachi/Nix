import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PropertyInput } from '../../../properties/property-input';
import { ValuePopover } from '../../../views/core/value-popover';
import type { PropertyDefinition } from '../../../views/core/container-model';

const owner = { title: 'Plan', properties: {} };

function setup(type: 'text' | 'date') {
  const property: PropertyDefinition = {
    key: 'f',
    label: 'Field',
    type,
    options: [],
    required: false,
  };
  const onCommit = vi.fn();
  render(
    <ValuePopover item={owner} property={property} density="cell">
      <PropertyInput item={owner} property={property} density="panel" onCommit={onCommit} />
    </ValuePopover>,
  );
  return onCommit;
}

describe('a value popover', () => {
  it('commits typed text and closes on Enter', async () => {
    const person = userEvent.setup();
    const onCommit = setup('text');
    await person.click(screen.getByRole('button', { name: /Field for Plan/ }));
    await person.type(screen.getByRole('textbox', { name: /Field/ }), 'Q3 plan{Enter}');
    expect(onCommit).toHaveBeenCalledWith('Q3 plan');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Enter in a date field', async () => {
    const person = userEvent.setup();
    const onCommit = setup('date');
    await person.click(screen.getByRole('button', { name: /Field for Plan/ }));
    await person.type(screen.getByLabelText(/Field/, { selector: 'input' }), '2026-03-17{Enter}');
    expect(onCommit).toHaveBeenCalledWith('2026-03-17');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
