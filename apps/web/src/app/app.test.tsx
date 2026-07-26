import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAt } from '../test/render-with-router';
import { App } from './app';

describe('the application shell', () => {
  it('renders the token page heading at the index route', () => {
    renderAt(<App />);

    expect(
      screen.getByRole('heading', { level: 1, name: /industry design tokens/i }),
    ).toBeVisible();
  });

  it('renders the layout chrome around the page', () => {
    renderAt(<App />);

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('tells the visitor which path was not found instead of showing a bare error', () => {
    renderAt(<App />, '/no-such-place');

    expect(screen.getByRole('heading', { name: /no such page/i })).toBeVisible();
    expect(screen.getByText(/no-such-place/)).toBeVisible();
  });
});

describe('state that lives in the URL', () => {
  it('renders the state named by the search parameter, so a link is shareable', () => {
    renderAt(<App />, '/?state=empty');

    expect(screen.getByRole('heading', { name: /no items here yet/i })).toBeVisible();
  });

  it('names what it is waiting for rather than showing an anonymous spinner', () => {
    renderAt(<App />, '/?state=loading');

    expect(screen.getByRole('heading', { name: /loading workspace items/i })).toBeVisible();
  });

  it('shows the data and says what is missing when the result is partial', () => {
    renderAt(<App />, '/?state=partial');

    expect(screen.getByText(/not yet indexed/i)).toBeVisible();
    expect(screen.getByText('Acquisition memo')).toBeVisible();
  });

  it('falls back to the default view when the parameter is not a known state', () => {
    renderAt(<App />, '/?state=nonsense');

    expect(screen.getByText('Acquisition memo')).toBeVisible();
  });

  it('recovers from the error state through its retry affordance', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/?state=error');

    expect(screen.getByRole('alert')).toHaveTextContent(/could not load workspace items/i);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Acquisition memo')).toBeVisible();
  });

  it('offers every state as a real link, not a button', () => {
    renderAt(<App />);

    const switcher = screen.getByRole('navigation', { name: /state pattern preview/i });
    expect(screen.getAllByRole('link')).not.toHaveLength(0);
    expect(switcher).toBeInTheDocument();
  });
});
