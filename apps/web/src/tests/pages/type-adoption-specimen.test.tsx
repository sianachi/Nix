import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TypeAdoptionSpecimen } from '../../pages/tokens/type-adoption-specimen';

/**
 * The type adoption specimen.
 *
 * A specimen is a page whose only job is to be looked at, so there is not much here that a test
 * can add - except the two things that would make looking at it useless. First, that it renders at
 * all: it is reached from one route nobody visits during a feature, so a crash in it survives a
 * whole phase. Second, that the parts it claims to show are actually in the DOM, because the
 * failure this specimen exists to catch - a scale growing a step nothing names - is exactly the
 * failure a half-rendered table hides.
 */
describe('the type adoption specimen', () => {
  it('shows every variant of the scale doing a job', () => {
    render(<TypeAdoptionSpecimen />);

    // `note` is the reason the specimen exists: it was a published step of the sheet that no
    // variant named, which is why twenty call sites wrote it by hand.
    for (const variant of ['h1', 'h2', 'h3', 'h4', 'h5', 'body', 'bodySmall', 'note', 'caption']) {
      expect(screen.getByText(variant)).toBeInTheDocument();
    }
  });

  it('shows the tracking scale as five named steps', () => {
    render(<TypeAdoptionSpecimen />);

    for (const step of ['tight', 'slight', 'wide', 'wider', 'widest']) {
      expect(screen.getByText(`tracking-${step}`)).toBeInTheDocument();
    }
  });

  it('states a reason beside every place a raw type class stays', () => {
    render(<TypeAdoptionSpecimen />);

    // Headings rather than text, so an entry that lost its explanation fails: the whole point of
    // the allowlist is that an exception without a reason is not an exception.
    const entries = screen.getAllByRole('heading', { level: 4 });
    expect(entries.length).toBeGreaterThanOrEqual(8);

    for (const entry of entries) {
      const row = entry.parentElement;
      if (row === null) {
        throw new Error(`The allowlist entry "${entry.textContent}" has no row around it.`);
      }
      expect(within(row).getAllByText(/\w/).length).toBeGreaterThan(1);
    }
  });

  it('names itself so the token page has a section a reviewer can point at', () => {
    render(<TypeAdoptionSpecimen />);

    expect(screen.getByRole('heading', { name: 'Type adoption' })).toBeInTheDocument();
  });
});
