import { fireEvent, screen, within } from '@testing-library/react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { renderAt } from '../test/render-with-router';
import { aContainer, views } from './container-fixture';
import type { EffectiveSchema, Item, PropertyDefinition, View } from './container-model';
import { GalleryView } from './gallery-view';
import type { ContainerData } from './use-container';

/**
 * The gallery, and above all what it says when a cover is not there.
 *
 * Every assertion here is a variation on one rule: **the items are the view, and the cover is
 * decoration on it.** Four different things can be wrong with a cover and none of them is allowed
 * to remove an item from the screen or to be described as one of the other three. The states are
 * near-identical on screen and completely different to the person reading them - "there is no
 * picture in this field" and "the picture in this field will not load" send somebody to two
 * different places - which is exactly the kind of distinction a build quietly collapses.
 */

const COVER: PropertyDefinition = {
  key: 'cover',
  label: 'Cover',
  type: 'image',
  options: [],
  required: false,
};

const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

function schemaOf(...properties: readonly PropertyDefinition[]): EffectiveSchema {
  return { properties: [...properties], declared: [...properties], inherit: true };
}

function itemOf(overrides: Partial<Item> & { id: string; title: string }): Item {
  return {
    workspaceId: 'a1000000-0000-4000-8000-000000000001',
    parentId: 'c1000000-0000-4000-8000-000000000001',
    type: 'note',
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function viewOf(overrides: Partial<View> = {}): View {
  return {
    id: 'v1000000-0000-4000-8000-000000000001',
    name: 'Covers',
    kind: 'gallery',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: 'cover',
    ...overrides,
  };
}

const SHOT = 'https://images.example.test/shot.jpg';
const GONE = 'https://images.example.test/deleted.jpg';

const WITH_COVER = itemOf({
  id: 'i1',
  title: 'Harbour at dawn',
  seq: 1000,
  properties: { cover: SHOT, owner: 'Ada' },
});

const WITHOUT_COVER = itemOf({
  id: 'i2',
  title: 'Notes from the site visit',
  seq: 2000,
  properties: { owner: 'Grace' },
});

function galleryOf(options: {
  readonly items: readonly Item[];
  readonly view?: View;
  readonly schema?: EffectiveSchema | null;
  readonly onOpen?: (itemId: string) => void;
}): ReactElement {
  const container: ContainerData = aContainer({
    schema: options.schema === undefined ? schemaOf(COVER, OWNER) : options.schema,
    views: views([]),
    children: [...options.items],
  });

  return (
    <GalleryView
      container={container}
      view={options.view ?? viewOf()}
      onOpen={options.onOpen ?? (() => undefined)}
    />
  );
}

/**
 * The card whose heading is this title. A card is a list item, so the list item is the card.
 *
 * Note the queries below ask for `presentation`, not `img`. A cover carries `alt=""`, which maps to
 * the implicit role `presentation` - so `queryByRole('img')` can never match one, and an assertion
 * written that way passes whether or not a picture is on screen. Three of the "no picture region at
 * all" assertions here were exactly that, and were the only guard on the states they covered.
 */
function card(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const item = heading.closest('li');

  if (item === null) {
    throw new Error(`"${title}" is not inside a card.`);
  }

  return item;
}

describe('the gallery view', () => {
  it('draws a card for every item whether or not it has a cover', () => {
    // The headline rule. An item with no picture is an item, and a gallery that showed only the
    // ones it could illustrate would be hiding the container's contents behind a decoration.
    renderAt(galleryOf({ items: [WITH_COVER, WITHOUT_COVER] }));

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notes from the site visit' })).toBeInTheDocument();

    const illustrated = within(card('Harbour at dawn')).getByRole('presentation', { hidden: true });
    expect(illustrated).toHaveAttribute('src', SHOT);
  });

  it('says a card has no cover rather than drawing an empty frame', () => {
    // An empty box is indistinguishable from a cover that failed to load and from a picture that
    // happens to be white. The words are the only thing that tells the three apart.
    renderAt(galleryOf({ items: [WITHOUT_COVER] }));

    const bare = card('Notes from the site visit');

    expect(within(bare).getByText('No cover')).toBeInTheDocument();
    expect(within(bare).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('draws no picture region at all when the view asks for no covers', () => {
    // Not "No cover" either: that would be reporting the absence of something nobody asked for. A
    // gallery with no cover property is a grid of titled cards, and the cards are complete.
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ coverProperty: null }) }));

    expect(screen.queryByText('No cover')).not.toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
  });

  it('says a cover could not be loaded rather than pretending the item has none', () => {
    // The distinction this test exists for. Falling back to "No cover" would claim the field is
    // empty when it holds a perfectly good address that is not resolving, and would send somebody
    // to re-enter a URL that is already right.
    const broken = itemOf({ id: 'i3', title: 'Site plan', properties: { cover: GONE } });

    renderAt(galleryOf({ items: [broken] }));

    fireEvent.error(within(card('Site plan')).getByRole('presentation', { hidden: true }));

    const failed = card('Site plan');

    expect(within(failed).getByText(/This cover could not be loaded/)).toBeInTheDocument();
    expect(within(failed).queryByText('No cover')).not.toBeInTheDocument();

    // The address is on screen, because it is the only thing here anybody can act on.
    expect(within(failed).getByText(GONE)).toBeInTheDocument();
  });

  it('says covers are unavailable when the property they came from is gone, and still shows every item', () => {
    // A schema edit made somewhere else, by somebody who has never seen this gallery. The notice
    // names the property; the grid keeps every card.
    renderAt(
      galleryOf({
        items: [WITH_COVER, WITHOUT_COVER],
        schema: schemaOf(OWNER),
      }),
    );

    const notice = screen.getByRole('status');

    expect(notice).toHaveTextContent('cover');
    expect(notice).toHaveTextContent('Every item is still here');

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notes from the site visit' })).toBeInTheDocument();

    // Coverless, not broken: nothing failed to load, so nothing may say it did.
    expect(screen.queryByText(/This cover could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('says covers are unavailable when the property they came from is no longer a picture', () => {
    // Retyping a picture to text is one edit in the schema panel. The value is still there and is
    // no longer something to put in an img src, so the gallery names the type it has become.
    renderAt(
      galleryOf({
        items: [WITH_COVER],
        schema: schemaOf({ ...COVER, type: 'text' }, OWNER),
      }),
    );

    const notice = screen.getByRole('status');

    expect(notice).toHaveTextContent('Cover');

    // The label a person was shown when they chose the type, never the stored token. Asserting the
    // token here would bake the jargon in - and the jargon is worse than it looks, because the
    // likeliest retype targets spell themselves "multi_select" and "timestamp".
    expect(notice).toHaveTextContent('Text');
    expect(notice).not.toHaveTextContent('multi_select');

    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('keeps a retyped cover property out of the card body rather than listing its address', () => {
    // The value is text now, so listing it as a column would be defensible - and would put a wall
    // of unreadable URLs under the titles, contradicting the notice directly above them. Somebody
    // chose it as the cover, not as a column.
    renderAt(
      galleryOf({
        items: [WITH_COVER],
        view: viewOf({ columns: ['cover', 'owner'] }),
        schema: schemaOf({ ...COVER, type: 'text' }, OWNER),
      }),
    );

    const retyped = card('Harbour at dawn');

    expect(within(retyped).queryByText(SHOT)).not.toBeInTheDocument();
    expect(within(retyped).getByText('Ada')).toBeInTheDocument();
  });

  it('refuses to point a picture at a value that is not a fetchable address', () => {
    // Reachable without the server ever having seen it: retyping a text property to Picture does
    // not revalidate what is already stored. Handed to an img this resolves against the workspace
    // origin and fetches the application shell, so it is caught before it becomes a request.
    const pasted = itemOf({ id: 'i5', title: 'Studio wall', properties: { cover: 'draft notes' } });

    renderAt(galleryOf({ items: [pasted] }));

    const wrong = card('Studio wall');

    expect(within(wrong).getByText('This is not a picture address')).toBeInTheDocument();
    expect(within(wrong).queryByText('No cover')).not.toBeInTheDocument();
    expect(within(wrong).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('names the property to correct when a cover will not load', () => {
    // The address is the evidence; the property is where the fix is made. Without the name,
    // somebody on a card with four properties has to guess which one held the picture.
    const broken = itemOf({ id: 'i6', title: 'Roof detail', properties: { cover: GONE } });

    renderAt(galleryOf({ items: [broken] }));

    fireEvent.error(within(card('Roof detail')).getByRole('presentation', { hidden: true }));

    expect(within(card('Roof detail')).getByText(/Check the address in Cover/)).toBeInTheDocument();
  });

  it('gives every card a heading, so a grid can be walked without tabbing through it', () => {
    // A gallery is a page of named things and nothing else. A span styled to look like a heading
    // leaves a screen reader user tabbing through every title button to move between cards.
    renderAt(galleryOf({ items: [WITH_COVER, WITHOUT_COVER] }));

    expect(screen.getAllByRole('heading')).toHaveLength(2);
  });

  it('does not send the workspace address to the host serving a cover', () => {
    // A cover URL is arbitrary and third-party - somebody pasted it into a property. Without this,
    // every reader's browser announces the page it came from, which is a workspace address carrying
    // the item id, to a host the workspace does not control. Same argument app.css makes for
    // refusing a font CDN.
    renderAt(galleryOf({ items: [WITH_COVER] }));

    const cover = within(card('Harbour at dawn')).getByRole('presentation', { hidden: true });

    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer');

    // Alongside it, because a wall of covers decoded and fetched eagerly blocks the scroll of the
    // grid they are in.
    expect(cover).toHaveAttribute('loading', 'lazy');
    expect(cover).toHaveAttribute('decoding', 'async');
  });

  it('names a cover nothing rather than repeating the title beside it', () => {
    // The picture carries nothing the card does not already say as text - the title is directly
    // beneath it. `alt={item.title}` would have a screen reader announce the same words twice.
    renderAt(galleryOf({ items: [WITH_COVER] }));

    expect(
      within(card('Harbour at dawn')).getByRole('presentation', { hidden: true }),
    ).toHaveAttribute('alt', '');
  });

  it('stops reporting a failure once the address changes', () => {
    // The failure belongs to a URL, not to a card. Somebody who corrects a typo must not be told
    // their corrected address failed too - which is what a flag reconciled in an effect, or not
    // reconciled at all, would tell them. Driven through a state change so the gallery meets the
    // new value the way it really does: a property write lands and the item arrives again.
    function Corrected(): ReactNode {
      const [cover, setCover] = useState(GONE);

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setCover(SHOT);
            }}
          >
            Correct the address
          </button>
          {galleryOf({ items: [itemOf({ id: 'i4', title: 'Elevation', properties: { cover } })] })}
        </>
      );
    }

    renderAt(<Corrected />);

    fireEvent.error(within(card('Elevation')).getByRole('presentation', { hidden: true }));
    expect(screen.getByText(/This cover could not be loaded/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Correct the address' }));

    expect(screen.queryByText(/This cover could not be loaded/)).not.toBeInTheDocument();
    expect(within(card('Elevation')).getByRole('presentation', { hidden: true })).toHaveAttribute(
      'src',
      SHOT,
    );
  });

  it('shows the properties the view asked for under a card, and never the cover among them', () => {
    // The cover is the picture; listing its address underneath as a field would be the same value
    // twice, once unreadably.
    renderAt(
      galleryOf({ items: [WITH_COVER], view: viewOf({ columns: ['cover', 'owner', 'title'] }) }),
    );

    const illustrated = card('Harbour at dawn');

    expect(within(illustrated).getByText('Owner')).toBeInTheDocument();
    expect(within(illustrated).getByText('Ada')).toBeInTheDocument();
    expect(within(illustrated).queryByText(SHOT)).not.toBeInTheDocument();
  });

  it('opens the item whose card was clicked', () => {
    const opened: string[] = [];

    renderAt(
      galleryOf({
        items: [WITH_COVER, WITHOUT_COVER],
        onOpen: (itemId) => opened.push(itemId),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Notes from the site visit' }));

    expect(opened).toEqual(['i2']);
  });

  it('says the container is empty rather than drawing an empty grid', () => {
    renderAt(galleryOf({ items: [] }));

    expect(screen.getByText('Nothing in here yet')).toBeInTheDocument();
  });
});
