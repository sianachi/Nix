import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PreviewModel } from '@nix/structure-spec';
import { PetStructurePreview } from '../../pets/pet-structure-preview';

function model(overrides: Partial<PreviewModel> = {}): PreviewModel {
  return {
    headline: 'I will create a reading board.',
    destination: { title: 'Reading log', path: ['Books', 'Reading log'] },
    counts: { items: 3, fields: 7, views: 2, entries: 0, writes: 12 },
    tree: [],
    notes: [],
    warnings: [],
    problems: [],
    neverDoes: ['Publish a public link', 'Delete anything permanently'],
    ...overrides,
  };
}

describe('PetStructurePreview', () => {
  it('renders the headline, destination and counts', () => {
    render(<PetStructurePreview model={model()} />);
    expect(screen.getByText('I will create a reading board.')).toBeVisible();
    expect(screen.getByText('In: Books / Reading log')).toBeVisible();
    expect(screen.getByText('3 items, 7 fields, 2 views, 0 entries, 12 writes')).toBeVisible();
    expect(screen.getByText(/This never: Publish a public link/)).toBeVisible();
  });

  it('collapses descendants beyond depth two with the full hidden-node count', async () => {
    render(
      <PetStructurePreview
        model={model({
          tree: [
            {
              label: 'Board',
              detail: [],
              children: [
                {
                  label: 'Reading list',
                  detail: [],
                  children: [
                    {
                      label: 'Fields',
                      detail: [],
                      children: [
                        { label: 'Rating', detail: [], children: [] },
                        { label: 'Finished', detail: [], children: [] },
                        { label: 'Notes', detail: [], children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        })}
      />,
    );
    expect(screen.queryByText('Rating')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getByText('Rating')).toBeVisible();
    expect(screen.getByText('Notes')).toBeVisible();
  });

  it('renders model-authored text literally without interpreting markup or links', () => {
    render(
      <PetStructurePreview
        model={model({
          tree: [
            {
              label: '<b>x</b> [link](javascript:alert(1))',
              detail: [],
              why: '<img src=x onerror=alert(1)>',
              children: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('<b>x</b> [link](javascript:alert(1))')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('puts blocking problems under an alert', () => {
    render(
      <PetStructurePreview
        model={model({
          problems: [{ path: 'fields[0].key', code: 'invalid', message: 'The key is not valid.' }],
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot run');
    expect(screen.getByRole('alert')).toHaveTextContent('fields[0].key: The key is not valid.');
  });
});
