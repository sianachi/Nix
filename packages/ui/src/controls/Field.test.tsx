import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Field } from './Field';
import { Input } from './Input';

describe('Field', () => {
  it('gives the control its label as an accessible name', () => {
    render(<Field label="Note title">{(control) => <Input {...control} />}</Field>);

    expect(screen.getByRole('textbox', { name: 'Note title' })).toBeInTheDocument();
  });

  it('describes the control with its hint', () => {
    render(
      <Field label="Note title" hint="Shown in the tree.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveAccessibleDescription(
      'Shown in the tree.',
    );
  });

  it('marks the control invalid and describes it with the error', () => {
    render(
      <Field label="Note title" error="A title is required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Note title' });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription('A title is required.');
  });

  it('replaces the hint with the error rather than showing both', () => {
    render(
      <Field label="Note title" hint="Shown in the tree." error="A title is required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    // Two lines of guidance under one field, one of which is now wrong, is worse than one line
    // that is right.
    expect(screen.queryByText('Shown in the tree.')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('A title is required.');
  });

  it('leaves a valid control unmarked', () => {
    render(<Field label="Note title">{(control) => <Input {...control} />}</Field>);

    const input = screen.getByRole('textbox', { name: 'Note title' });

    // Absent rather than aria-invalid="false": a field nobody has failed yet is not a field that
    // has passed.
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAccessibleDescription();
  });

  it('generates identifiers per field, so two fields on a page never collide', () => {
    render(
      <>
        <Field label="First">{(control) => <Input {...control} />}</Field>
        <Field label="Second">{(control) => <Input {...control} />}</Field>
      </>,
    );

    const first = screen.getByRole('textbox', { name: 'First' });
    const second = screen.getByRole('textbox', { name: 'Second' });

    expect(first.id).not.toBe(second.id);
  });

  it('announces a required field to assistive technology as well as drawing an asterisk', () => {
    render(
      <Field label="Note title" required>
        {(control) => <Input {...control} required />}
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Note title' })).toBeRequired();
  });
});
