import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Duotone } from './Duotone';

const COVER = 'https://cdn.example.com/covers/master-services-agreement.jpg';

/** The one `<img>` a `<Duotone>` renders. The sibling `<svg>` is the filter, never an image. */
function imageIn(container: HTMLElement): HTMLImageElement {
  const image = container.querySelector('img');
  if (image === null) {
    throw new Error('no image rendered');
  }
  return image;
}

describe('Duotone', () => {
  it('renders the image it was given, named by its alt text', () => {
    render(<Duotone src={COVER} alt="Aerial view of the harbour" />);

    expect(screen.getByRole('img', { name: 'Aerial view of the harbour' })).toHaveAttribute(
      'src',
      COVER,
    );
  });

  it('never sends the workspace URL to the host serving the image', () => {
    // A security property, not a preference. A cover URL is arbitrary third-party bytes; without
    // this the browser announces the page it was rendered on - which carries the item id - to a
    // host the workspace does not control, on every render. There is no prop that unsets it.
    const { container } = render(<Duotone src={COVER} alt="" />);

    expect(imageIn(container)).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('decodes off the main thread and defers loading until the image is near the viewport', () => {
    const { container } = render(<Duotone src={COVER} alt="" />);
    const image = imageIn(container);

    expect(image).toHaveAttribute('decoding', 'async');
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('loads eagerly when the caller knows the image is already on screen', () => {
    const { container } = render(<Duotone src={COVER} alt="" loading="eager" />);

    expect(imageIn(container)).toHaveAttribute('loading', 'eager');
  });

  it('tells the caller when the image fails to load', () => {
    const onError = vi.fn();
    const { container } = render(
      <Duotone src="data:image/png;base64,x" alt="" onError={onError} />,
    );

    fireEvent.error(imageIn(container));

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('says nothing of its own about a failed image', () => {
    // The gallery has to word "no cover configured", "no value set" and "failed to load"
    // differently. A placeholder or a message drawn here would fight the only code that can tell
    // those apart.
    //
    // The scope of this test is what *this component* renders. It says nothing about the user
    // agent's own broken-image chrome, which jsdom does not draw and which a caller is expected
    // to replace on `onError` - see the note on failure in Duotone.tsx.
    const { container } = render(<Duotone src="data:image/png;base64,x" alt="" />);

    fireEvent.error(imageIn(container));

    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('drops out of the accessibility tree when its alt is empty', () => {
    render(<Duotone src={COVER} alt="" />);

    // An empty alt is the caller saying the surrounding text already carries this. The filter's
    // own <svg> must not sneak in as a second graphic either.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('graphics-document')).not.toBeInTheDocument();
  });

  it('gives every instance its own filter, addressable from a CSS url()', () => {
    const { container } = render(
      <>
        <Duotone src={COVER} alt="" />
        <Duotone src={COVER} alt="" />
      </>,
    );

    const ids = [...container.querySelectorAll('filter')].map((filter) => filter.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // React spends punctuation on useId values; a generated id reaches a `url(#...)` reference, so
    // it may only carry characters every browser reads back the same way.
    for (const id of ids) {
      expect(id).toMatch(/^duotone-[A-Za-z0-9_-]+$/);
    }

    // Each image points at its own filter rather than at whichever one is first in the document.
    const images = [...container.querySelectorAll('img')];
    expect(images).toHaveLength(2);
    for (const [index, image] of images.entries()) {
      expect(image.getAttribute('style')).toContain(`url(#${String(ids[index])})`);
    }
  });

  it('maps luminance onto the two ramp steps that do not move with the ground', () => {
    // Named exactly rather than matched loosely, because the point is not "some token" - it is
    // these two. Semantic roles swap ends between grounds, so a photograph built from them comes
    // out as its own negative on ink: a sky darker than the hills under it. If you are here
    // because you changed these to `--color-foreground` and `--color-surface`, that is what you
    // just shipped. See the note on grounds in Duotone.tsx.
    const { container } = render(<Duotone src={COVER} alt="" />);

    const floods = [...container.querySelectorAll('feFlood')].map((flood) =>
      flood.getAttribute('style'),
    );
    expect(floods).toEqual([
      'flood-color: var(--color-neutral-100);',
      'flood-color: var(--color-accent-900);',
    ]);
    expect(container.innerHTML).not.toContain('dark:');
  });

  it('carries its tones as CSS rather than as SVG presentation attributes', () => {
    // `<feFlood flood-color="var(--x)">` is the obvious cleanup and it does not work: a
    // presentation attribute does not resolve var(), and the flood falls back to black without
    // saying so - every photograph in the product, a black-on-black silhouette, no warning.
    const { container } = render(<Duotone src={COVER} alt="" />);

    for (const flood of container.querySelectorAll('feFlood')) {
      expect(flood.getAttribute('flood-color')).toBeNull();
      expect(flood.getAttribute('style')).toContain('flood-color: var(--color-');
    }
  });

  it('filters exactly the image and not the empty margin around it', () => {
    // The default filter region is -10%/-10%/120%/120% of the box. No primitive here displaces a
    // pixel, so that extra 44% of area is filtered and then thrown away, once per cover.
    const { container } = render(<Duotone src={COVER} alt="" />);
    const filter = container.querySelector('filter');

    expect(filter?.getAttribute('x')).toBe('0');
    expect(filter?.getAttribute('y')).toBe('0');
    expect(filter?.getAttribute('width')).toBe('1');
    expect(filter?.getAttribute('height')).toBe('1');
  });

  it('hides the filter it carries from assistive technology and from the pointer', () => {
    const { container } = render(<Duotone src={COVER} alt="Harbour at dusk" />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    // Zero-sized and out of flow: a <Duotone> occupies exactly the space of its image.
    expect(svg?.getAttribute('class')).toContain('absolute');
    expect(svg?.getAttribute('class')).toContain('size-0');
  });

  it('lets the caller size the image without losing the treatment', () => {
    const { container } = render(
      <Duotone src={COVER} alt="" className="h-40 w-full object-cover" />,
    );
    const image = imageIn(container);

    expect(image.className).toContain('h-40');
    expect(image.className).toContain('object-cover');
    expect(image.getAttribute('style')).toContain('filter: url(#duotone-');
  });
});
