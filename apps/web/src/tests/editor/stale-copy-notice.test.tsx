import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaleCopyNotice } from '../../editor/stale-copy-notice';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stale local copy notice', () => {
  it('says the copy is older and unsaved, and offers the reload an installed window lacks', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    render(<StaleCopyNotice noun="note" />);

    expect(screen.getByRole('alert')).toHaveTextContent(/older copy/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/not saved/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));

    expect(reload).toHaveBeenCalledOnce();
  });
});
