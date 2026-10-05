import type { ReactElement } from 'react';

import { Card, Text } from '@nix/ui';

/**
 * Type specimen: Barlow Condensed headings over Barlow body copy, both
 * selected through the --font-heading / --font-body token utilities. If the
 * token sheet failed to load, every line below falls back to the same system
 * stack and the pairing visibly collapses - which makes this the fastest
 * visual check that the theme is wired up.
 */
export function TypeSpecimen(): ReactElement {
  return (
    <Card kicker="Foundations" title="Type">
      <Text variant="h2">Heading two, condensed</Text>
      <Text variant="h3">Heading three, condensed</Text>
      <Text variant="h4">Heading four, condensed</Text>
      <Text>
        Body copy is Barlow at a comfortable reading measure. Headings condense above it, which is
        what gives the system its technical, drawn-to-spec feel. Nothing on this page names a font
        family; every line asks the token sheet for one.
      </Text>
      <Text tone="muted">
        Muted body copy steps down to neutral-700 rather than reducing opacity, so text stays crisp
        against the ground.
      </Text>
    </Card>
  );
}
