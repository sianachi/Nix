import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InteractiveFormView } from '../../../views/form/interactive-form-view';
import { aContainer } from '../../container-fixture';
import { renderAt } from '../../render-with-router';
import { aView } from '../../view-fixture';

const interactiveForm = {
  pages: [
    {
      id: 'start',
      title: 'Check in',
      description: null,
      visibleWhen: [],
      blocks: [
        {
          id: 'mood',
          kind: 'field',
          propertyKey: 'mood',
          text: 'Mood',
          help: null,
          required: true,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
    {
      id: 'detail-page',
      title: 'Tell us more',
      description: null,
      visibleWhen: [{ fieldBlockId: 'mood', operator: 'equals', value: 'Low' }],
      blocks: [
        {
          id: 'detail',
          kind: 'field',
          propertyKey: 'detail',
          text: 'What happened?',
          help: null,
          required: true,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
  ],
  titleMode: 'field',
  titleFieldBlockId: 'mood',
  confirmationTitle: 'Recorded',
  confirmationMessage: 'Thanks for checking in.',
};

function renderForm(
  create: (title: string, properties?: Record<string, unknown>) => Promise<string | null>,
): void {
  renderAt(
    <InteractiveFormView
      container={aContainer({
        schema: {
          properties: [
            {
              key: 'mood',
              label: 'Mood',
              type: 'select',
              options: ['Good', 'Low'],
              required: false,
            },
            { key: 'detail', label: 'Detail', type: 'text', options: [], required: false },
          ],
          declared: [],
          inherit: true,
        },
        create,
      })}
      view={aView({ kind: 'interactive_form', interactiveForm })}
      onOpen={vi.fn()}
    />,
  );
}

describe('interactive forms', () => {
  it('navigates visible pages, enforces their required fields, and creates schema-backed properties', async () => {
    const create = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderForm(create);

    await user.selectOptions(screen.getByLabelText('Mood'), 'Low');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(screen.getByText('This answer is required.')).toBeInTheDocument();

    const detail = screen.getByLabelText('What happened?');
    await vi.waitFor(() => {
      expect(detail).toHaveFocus();
    });
    await user.type(detail, 'A difficult morning');
    fireEvent.blur(detail);
    await user.click(screen.getByRole('button', { name: 'Send response' }));

    expect(await screen.findByText('Recorded')).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith('Low', { mood: 'Low', detail: 'A difficult morning' });
  });

  it('does not require or submit fields hidden by conditions', async () => {
    const create = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderForm(create);

    await user.selectOptions(screen.getByLabelText('Mood'), 'Good');
    await user.click(screen.getByRole('button', { name: 'Send response' }));

    expect(create).toHaveBeenCalledWith('Good', { mood: 'Good' });
  });
});
