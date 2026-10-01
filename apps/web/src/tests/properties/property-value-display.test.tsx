import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PropertyDefinition } from '../../views/core/container-model';
import { PropertyValueDisplay } from '../../properties/property-value-display';

function property(key: string, type: string): PropertyDefinition {
  return {
    key,
    label: key,
    type,
    options: [],
    required: false,
    expression: null,
    aggregate: null,
    source: null,
  };
}

function show(type: string, value: unknown) {
  return render(
    <PropertyValueDisplay
      item={{ title: 'Item', properties: { field: value } }}
      property={property('field', type)}
    />,
  );
}

describe('a property value, read rather than edited', () => {
  it('draws nothing for an empty value, so a card has no blank labels', () => {
    const { container } = show('text', '');
    expect(container).toBeEmptyDOMElement();
  });

  it('never renders an editing control', () => {
    for (const [type, value] of [
      ['select', 'Doing'],
      ['multi_select', ['a', 'b']],
      ['checkbox', true],
      ['number', 3],
      ['priority', 2],
      ['date', '2026-03-04'],
    ] as const) {
      const { unmount } = show(type, value);
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows choices as tags and a priority by its word', () => {
    show('multi_select', ['Design', 'Q3']);
    expect(screen.getByText('Design')).toBeVisible();
    expect(screen.getByText('Q3')).toBeVisible();

    show('priority', 1);
    expect(screen.getByText('P1 Urgent')).toBeVisible();
  });

  it('reads a checkbox out in words, not as a glyph alone', () => {
    show('completion', true);
    expect(screen.getByText('field: yes')).toBeInTheDocument();
  });

  it('formats numbers and writes a stored day in words without shifting it', () => {
    show('estimate', 1234.5);
    expect(
      screen.getByText(
        new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(1234.5),
      ),
    ).toBeVisible();

    show('date', '2026-03-04');
    // The reader's locale decides the words; the day must be the 4th wherever the reader sits.
    const expected = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(Date.UTC(2026, 2, 4));
    expect(screen.getByText(expected)).toBeVisible();
  });

  it('says a past due date is overdue in words as well as tone', () => {
    show('due_date', '2000-01-01');
    expect(screen.getByText('(overdue)', { exact: false })).toBeInTheDocument();
  });

  it('admits it does not know an assignee no directory can name', () => {
    show('assignee', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(screen.getByText('Unknown member')).toBeVisible();
  });

  it('shows a link by its host, opening somewhere else', () => {
    show('url', 'https://example.com/a/very/long/path');
    const link = screen.getByRole('link', { name: 'example.com' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
