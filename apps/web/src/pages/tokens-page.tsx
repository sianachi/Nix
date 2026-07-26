import type { ReactElement } from 'react';

import { Heading, Text } from '../components/typography';
import { ColorSpecimen } from './tokens/color-specimen';
import { ShapeSpecimen, SpacingSpecimen } from './tokens/scale-specimen';
import { StateGallery } from './tokens/state-gallery';
import { TypeSpecimen } from './tokens/type-specimen';

/**
 * The token specimen page.
 *
 * It has two jobs. For a reader it is the reference sheet for the Industry
 * design language as Nix implements it. For the build it is the end-to-end
 * proof that packages/design-tokens survives a real Tailwind v4 compile: every
 * colour, font, space, radius and shadow on this page is a token-backed
 * utility class, so if the @theme sheet stopped resolving, the page would fall
 * apart visibly rather than fail quietly in a unit test.
 *
 * The page itself holds no state. Sections take constants or the URL; nothing
 * here fetches, and there is no store. That is deliberate - the api-client and
 * the Zustand slices arrive in later goals, and this page should keep working
 * without either.
 */
export function TokensPage(): ReactElement {
  return (
    <div className="flex flex-col gap-8">
      {/* A div, not a <header>: the document has exactly one banner, and it
          is the application header in the root layout. */}
      <div className="flex flex-col gap-3">
        <Heading level={1}>Industry design tokens</Heading>
        <Text tone="muted" className="max-w-prose">
          Steel-blue on a light technical ground, Barlow Condensed over Barlow, and objects framed
          as blueprint line drawings. Everything below is drawn with token-backed utility classes
          only; there is no stylesheet in this application other than the Tailwind entry.
        </Text>
      </div>

      <TypeSpecimen />
      <ColorSpecimen />
      <SpacingSpecimen />
      <ShapeSpecimen />
      <StateGallery />
    </div>
  );
}
