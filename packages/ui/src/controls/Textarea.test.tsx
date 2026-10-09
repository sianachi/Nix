import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Textarea } from './Textarea';

describe('Textarea', () => {
  it('is a multi-line text box wearing the same frame as Input', () => {
    render(<Textarea aria-label="Body" />);

    const field = screen.getByRole('textbox', { name: 'Body' });
    expect(field.tagName).toBe('TEXTAREA');
    // The frame is the point of the control: a hand-styled copy is what it replaces.
    expect(field.className).toContain('rounded-md');
    expect(field.className).toContain('border-divider');
    expect(field.className).toContain('any-pointer-coarse:text-lg');
    expect(field.className).toContain('min-w-0');
  });

  it('shows three rows unless told otherwise', () => {
    const { rerender } = render(<Textarea aria-label="Body" />);
    expect(screen.getByRole('textbox', { name: 'Body' })).toHaveAttribute('rows', '3');

    rerender(<Textarea aria-label="Body" rows={6} />);
    expect(screen.getByRole('textbox', { name: 'Body' })).toHaveAttribute('rows', '6');
  });

  it('resizes vertically by default and not at all when the layout owns the height', () => {
    const { rerender } = render(<Textarea aria-label="Body" />);
    expect(screen.getByRole('textbox', { name: 'Body' }).className).toContain('resize-y');

    rerender(<Textarea aria-label="Body" resize="none" />);
    const className = screen.getByRole('textbox', { name: 'Body' }).className;
    expect(className).toContain('resize-none');
    expect(className).not.toContain('resize-y');
  });

  it('grows with its content, cannot be dragged, and leaves rows unset when autoGrow is on', () => {
    render(<Textarea aria-label="Body" autoGrow resize="vertical" />);

    const field = screen.getByRole('textbox', { name: 'Body' });
    expect(field.className).toContain('[field-sizing:content]');
    // A drag handle on a box that sizes itself would fight the content.
    expect(field.className).toContain('resize-none');
    expect(field.className).not.toContain('resize-y');
    expect(field).not.toHaveAttribute('rows');
  });

  it('does not grow with its content unless asked', () => {
    render(<Textarea aria-label="Body" />);

    expect(screen.getByRole('textbox', { name: 'Body' }).className).not.toContain('field-sizing');
  });

  it('drops the hairline and the fill in the plain tone, and keeps the corner', () => {
    render(<Textarea aria-label="Body" tone="plain" />);

    const className = screen.getByRole('textbox', { name: 'Body' }).className;
    expect(className).toContain('border-transparent');
    expect(className).toContain('bg-transparent');
    expect(className).not.toContain('border-divider');
    expect(className).toContain('rounded-md');
  });

  it('carries the single-ring field focus, not the detached ring', () => {
    render(<Textarea aria-label="Body" />);

    const className = screen.getByRole('textbox', { name: 'Body' }).className;
    expect(className).toContain('focus-visible:outline-offset-0');
    expect(className).not.toContain('focus-visible:outline-offset-2');
  });

  it('reports invalidity through aria-invalid so it is announced, not only drawn', () => {
    render(<Textarea aria-label="Body" aria-invalid />);

    expect(screen.getByRole('textbox', { name: 'Body' })).toBeInvalid();
  });

  it('forwards its ref and its props to the textarea', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    const onChange = vi.fn();
    render(
      <Textarea
        ref={ref}
        aria-label="Body"
        maxLength={40}
        placeholder="Write"
        onChange={onChange}
      />,
    );

    const field = screen.getByRole('textbox', { name: 'Body' });
    expect(ref.current).toBe(field);
    expect(field).toHaveAttribute('maxlength', '40');
    expect(field).toHaveAttribute('placeholder', 'Write');

    await user.type(field, 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps a newline typed with Enter', async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Body" />);

    const field = screen.getByRole('textbox', { name: 'Body' });
    await user.type(field, 'one{Enter}two');

    expect(field).toHaveValue('one\ntwo');
  });

  it('cannot be typed into when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Textarea aria-label="Body" disabled onChange={onChange} />);

    await user.type(screen.getByRole('textbox', { name: 'Body' }), 'x');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('appends a caller class for layout without losing the control s own', () => {
    render(<Textarea aria-label="Body" className="max-h-40" />);

    const className = screen.getByRole('textbox', { name: 'Body' }).className;
    expect(className).toContain('max-h-40');
    expect(className).toContain('rounded-md');
  });
});
