import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card } from './Card';

describe('Card', () => {
  it('renders its title as a heading', () => {
    render(<Card title="Retention">Thirty days.</Card>);

    expect(screen.getByRole('heading', { level: 2, name: 'Retention' })).toBeInTheDocument();
  });

  it('lets the caller place the title in the page outline', () => {
    render(
      <Card title="Retention" headingLevel={3}>
        Thirty days.
      </Card>,
    );

    // A card cannot know its own depth, so a hard-coded level would break the outline on the
    // first page that nests one.
    expect(screen.getByRole('heading', { level: 3, name: 'Retention' })).toBeInTheDocument();
  });

  it('renders its body', () => {
    render(<Card title="Retention">Thirty days.</Card>);

    expect(screen.getByText('Thirty days.')).toBeInTheDocument();
  });

  it('renders a kicker above the title when one is given', () => {
    render(
      <Card title="Retention" kicker="Workspace">
        Thirty days.
      </Card>,
    );

    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('omits the kicker element entirely when there is none', () => {
    const { container } = render(<Card title="Retention">Thirty days.</Card>);

    expect(container.querySelectorAll('span')).toHaveLength(
      // Only the four registration marks' boxes carry spans of their own; a kicker would add one
      // more. Counting is how an empty element that still occupies space gets caught.
      container.querySelectorAll('[aria-hidden="true"] span').length +
        container.querySelectorAll('[aria-hidden="true"]').length,
    );
  });

  it('is a section rather than an article, and is not a banner', () => {
    render(
      <Card title="Retention" aria-label="Retention policy">
        Thirty days.
      </Card>,
    );

    expect(screen.getByRole('region', { name: 'Retention policy' })).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });
});
