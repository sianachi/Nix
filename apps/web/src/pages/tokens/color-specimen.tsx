import type { ReactElement } from 'react';

import { Card } from '../../components/card';
import { Kicker, Text } from '../../components/typography';
import { cx } from '../../lib/cx';
import { ACCENT_RAMP, NEUTRAL_RAMP, ROLE_SWATCHES, type Swatch } from './specimens';

/**
 * Colour specimens. Each chip is nothing but a token-backed utility class, so
 * a chip rendering the wrong colour means the token pipeline is broken - which
 * is exactly what this page exists to detect.
 *
 * The swatch labels are token names, never values. If you want to know what
 * accent-500 resolves to, read packages/design-tokens or the built stylesheet.
 */

function SwatchRow({
  title,
  swatches,
}: {
  readonly title: string;
  readonly swatches: readonly Swatch[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Kicker>{title}</Kicker>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-9">
        {swatches.map((swatch) => (
          <li key={swatch.token} className="flex flex-col gap-1">
            <span
              aria-hidden="true"
              className={cx('block h-12 w-full border border-divider', swatch.className)}
            />
            <Text tone="muted" as="span" size="xs">
              {swatch.token}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ColorSpecimen(): ReactElement {
  return (
    <Card kicker="Foundations" title="Colour">
      <Text tone="muted">
        One steel accent on a light technical ground. Each role carries a 100 to 900 ramp on a
        shared perceptual lightness scale, so the same step of any ramp has the same visual weight.
        Light steps tint fills and borders, 500 is the base, dark steps carry text on tinted fills
        and pressed states.
      </Text>
      <SwatchRow title="Accent ramp" swatches={ACCENT_RAMP} />
      <SwatchRow title="Neutral ramp" swatches={NEUTRAL_RAMP} />
      <SwatchRow title="Semantic roles" swatches={ROLE_SWATCHES} />
      <Text tone="accent">
        This sentence is body-size accent text, so it renders at accent-700 rather than the base
        accent, which is tuned to roughly 3:1 against the ground and is meant for chrome.
      </Text>
    </Card>
  );
}
