import { fireEvent, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { renderAt } from '../../render-with-router';
import type { PropertyDefinition, ViewFilterRule } from '../../../views/core/container-model';
import { FilterRulesEditor } from '../../../views/query/filter-rules-editor';

/**
 * The filter-rules editor: rows of property, condition and value, with the two honesty properties
 * that matter - a property is typed rather than picked (the query spans containers), and a token
 * from a newer build survives the editor untouched.
 */

const SCHEMA: readonly PropertyDefinition[] = [
  { key: 'due', label: 'Due', type: 'date', options: [], required: false },
  { key: 'status', label: 'Status', type: 'select', options: ['Doing'], required: false },
];

function editorWith(initial: readonly ViewFilterRule[]): {
  current: () => readonly ViewFilterRule[];
} {
  let latest: readonly ViewFilterRule[] = initial;

  function Harness(): ReactNode {
    const [rules, setRules] = useState<readonly ViewFilterRule[]>(initial);
    latest = rules;
    return (
      <FilterRulesEditor
        rules={rules}
        schema={SCHEMA}
        onChange={(next) => {
          setRules(next);
        }}
      />
    );
  }

  renderAt(<Harness />);
  return { current: () => latest };
}

describe('the filter rules editor', () => {
  it('adds a rule ready to be filled', () => {
    const rules = editorWith([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));

    expect(rules.current()).toEqual([{ property: '', operator: 'equals', value: '' }]);
    expect(screen.getByLabelText('Property')).toBeInTheDocument();
  });

  it('edits a rule field by field', () => {
    const rules = editorWith([{ property: 'due', operator: 'before', value: 'today' }]);

    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2026-09-01' } });

    expect(rules.current()).toEqual([{ property: 'due', operator: 'before', value: '2026-09-01' }]);
  });

  it('removes the one rule its button names', () => {
    const rules = editorWith([
      { property: 'due', operator: 'before', value: 'today' },
      { property: 'done', operator: 'not-equals', value: 'true' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove the filter on due' }));

    expect(rules.current()).toEqual([{ property: 'done', operator: 'not-equals', value: 'true' }]);
  });

  it('hints the value grammar the chosen operator reads', () => {
    editorWith([{ property: 'due', operator: 'within-next', value: '7' }]);

    expect(screen.getByText('A number of days, 1 to 365')).toBeInTheDocument();
  });

  it('preserves an operator token from a newer build rather than rewriting it', () => {
    const rules = editorWith([{ property: 'due', operator: 'sometime-around', value: 'x' }]);

    // The stray token is offered as the current choice, and leaving the row alone changes
    // nothing: only the server executes, and this build must not silently rewrite a saved rule.
    expect(screen.getByLabelText('Condition')).toHaveValue('sometime-around');
    expect(rules.current()).toEqual([{ property: 'due', operator: 'sometime-around', value: 'x' }]);
  });

  it('says the rules run across containers, which is why the property is typed', () => {
    editorWith([]);

    expect(screen.getByText(/across every container you can read/)).toBeInTheDocument();
  });
});
