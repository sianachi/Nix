import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Select } from './Select';

describe('Select', () => {
  it('is the platform s own control', () => {
    render(
      <Select aria-label="Type">
        <option value="text">Text</option>
        <option value="date">Date</option>
      </Select>,
    );

    // Native, so typeahead, arrow keys, home and end, and the system picker on a phone all come
    // free - and correctly, which a built listbox rarely manages in every combination.
    expect(screen.getByRole('combobox', { name: 'Type' }).tagName).toBe('SELECT');
  });

  it('reports what was chosen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Select aria-label="Type" defaultValue="text" onChange={onChange}>
        <option value="text">Text</option>
        <option value="date">Date</option>
      </Select>,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'date');
    expect(onChange).toHaveBeenCalled();
  });

  it('stands the same height as an input beside it', () => {
    render(
      <Select aria-label="Type">
        <option value="text">Text</option>
      </Select>,
    );

    // The control scale's middle step, the same one `<Input>` uses. A select and a field in one row
    // that disagreed about their height is exactly what this package exists to prevent.
    expect(screen.getByRole('combobox').className).toContain('h-(--control-md)');
  });

  it('takes a layout class without losing its own', () => {
    render(
      <Select aria-label="Type" className="w-40">
        <option value="text">Text</option>
      </Select>,
    );

    const select = screen.getByRole('combobox');
    expect(select.className).toContain('w-40');
    expect(select.className).toContain('border-divider');
  });
});
