import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_VIEWS, DemoPage } from '../../demo/demo-page';

/** The demo draws every offered view from sample data in the tab and never asks the server. */
describe('the demo page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens every view over the sample data without a single request', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('The demo must not reach the network'));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();

    render(<DemoPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'This week' })).toBeVisible();
    for (const view of DEMO_VIEWS) {
      await user.click(screen.getByRole('button', { name: view.name }));
      expect(await screen.findAllByText('Plan the week')).not.toHaveLength(0);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
