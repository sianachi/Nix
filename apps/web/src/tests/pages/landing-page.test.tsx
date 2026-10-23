import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { LandingPage } from '../../pages/landing-page';

/** The hero opens on a note and steps through every view, by pointer or by arrow keys. */
describe('the landing page view gallery', () => {
  it('opens on the note and moves between views', async () => {
    const user = userEvent.setup();
    render(<LandingPage onSignIn={() => undefined} demo />);

    const picture = (): string | null =>
      screen.getByRole('tabpanel').querySelector('img')?.getAttribute('src') ?? null;
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    expect(picture()).toBe('/landing/note.jpg');

    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(picture()).toBe('/landing/timeline.jpg');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Spreadsheet' })).toHaveFocus();
    expect(picture()).toBe('/landing/sheet.jpg');

    await user.keyboard('{End}');
    expect(picture()).toBe('/landing/companion.png');
    await user.keyboard('{ArrowRight}');
    expect(picture()).toBe('/landing/note.jpg');
  });
});
