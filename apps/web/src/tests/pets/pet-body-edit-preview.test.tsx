import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PetBodyEditPreview } from '../../pets/pet-body-edit-preview';

describe('PetBodyEditPreview', () => {
  it('names both sides in words and shows each in full as plain text', () => {
    render(
      <PetBodyEditPreview
        edit={{
          before: '## Budget\n\nTotal is **400**.',
          after: '## Budget\n\nTotal is **450**.\n\n- Venue\n- Food',
          blocksRemoved: 1,
          blocksAdded: 2,
        }}
      />,
    );
    const now = screen.getByRole('region', { name: 'Text now' });
    const after = screen.getByRole('region', { name: 'Text after this change' });
    // Plain text, never rendered Markdown: the model chose the new side.
    expect(now).toHaveTextContent('## Budget Total is **400**.');
    expect(after).toHaveTextContent('Total is **450**. - Venue - Food');
    expect(within(now).queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('Text now (3 lines)')).toBeVisible();
    expect(screen.getByText('Text after this change (6 lines)')).toBeVisible();
    // Both regions take focus so a long side scrolls from the keyboard.
    expect(now).toHaveAttribute('tabindex', '0');
    expect(after).toHaveAttribute('tabindex', '0');
  });

  it('says in words when the edit removes the text', () => {
    render(
      <PetBodyEditPreview
        edit={{ before: 'Second note.', after: '', blocksRemoved: 1, blocksAdded: 0 }}
      />,
    );
    expect(screen.getByRole('region', { name: 'Text after this change' })).toHaveTextContent(
      '(removed: nothing replaces it)',
    );
  });
});
