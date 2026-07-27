import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Text, type TextVariant } from './Text';

const BODY_SIZED: TextVariant[] = [
  // h3 is 22px on the type scale, under WCAG's 24px large-text threshold at weight 600, so it
  // belongs on this side of the line even though it is a display heading by name.
  'h3',
  'h4',
  'h5',
  'h6',
  'body',
  'bodySmall',
  'caption',
  'kicker',
];
const DISPLAY_SIZED: TextVariant[] = ['h1', 'h2'];

describe('Text', () => {
  it('renders a heading variant as a heading of the matching level', () => {
    render(<Text variant="h2">Workspace</Text>);

    expect(screen.getByRole('heading', { level: 2, name: 'Workspace' })).toBeInTheDocument();
  });

  it('renders body copy as a paragraph', () => {
    const { container } = render(<Text>Every view states its own truth.</Text>);

    expect(container.querySelector('p')).toHaveTextContent('Every view states its own truth.');
  });

  it('lets the document outline override the tag without changing the look', () => {
    render(
      <Text variant="h1" as="h2">
        Workspace
      </Text>,
    );

    const heading = screen.getByRole('heading', { level: 2, name: 'Workspace' });
    expect(heading.className).toContain('text-3xl');
  });

  it('sets headings in the condensed family and body copy in the body family', () => {
    const { container: headingBox } = render(<Text variant="h3">Workspace</Text>);
    const { container: bodyBox } = render(<Text variant="body">Workspace</Text>);

    expect(headingBox.firstElementChild?.className).toContain('font-heading');
    expect(bodyBox.firstElementChild?.className).toContain('font-body');
  });

  it.each(BODY_SIZED)('resolves accent tone to accent-700 at %s size', (variant) => {
    const { container } = render(
      <Text variant={variant} tone="accent">
        Indexed
      </Text>,
    );

    const className = container.firstElementChild?.className ?? '';
    expect(className).toContain('text-accent-text');
    expect(className).not.toMatch(/(^|\s)text-accent(\s|$)/);
  });

  it.each(DISPLAY_SIZED)('allows the base accent at display size %s', (variant) => {
    const { container } = render(
      <Text variant={variant} tone="accent">
        Indexed
      </Text>,
    );

    const className = container.firstElementChild?.className ?? '';
    expect(className).toMatch(/(^|\s)text-accent(\s|$)/);
    expect(className).not.toContain('text-accent-text');
  });

  it('accepts a layout class without dropping its typography', () => {
    const { container } = render(
      <Text variant="body" className="mt-4">
        Copy
      </Text>,
    );

    const className = container.firstElementChild?.className ?? '';
    expect(className).toContain('mt-4');
    expect(className).toContain('text-md');
  });

  it('names a step of the token sheet type scale rather than a pixel size', () => {
    // The whole point of ADR-0008: a remaining `text-[13px]` is a defect a reviewer can point at,
    // which it could not be while this component was the scale's only home.
    for (const variant of [...DISPLAY_SIZED, ...BODY_SIZED]) {
      const { container, unmount } = render(<Text variant={variant}>Copy</Text>);

      expect(container.firstElementChild?.className ?? '').not.toMatch(/text-\[[\d.]+px\]/);
      unmount();
    }
  });
});
