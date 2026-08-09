import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Text, type TextVariant } from './Text';

/**
 * The type scale and the three tones a caller can choose.
 *
 * The accent tone is the interesting one: the same prop resolves to the base
 * accent at display size and to `--color-accent-text` everywhere else, because
 * the accent/ground pair is only about 3:1. axe checks that on every story
 * below, on both grounds.
 */
const meta = {
  title: 'Primitives/Text',
  component: Text,
  parameters: { layout: 'padded' },
  args: {
    children: 'Documents that tell the truth about themselves',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'body',
        'bodySmall',
        'note',
        'caption',
        'kicker',
      ] satisfies TextVariant[],
    },
    tone: { control: 'inline-radio', options: ['default', 'muted', 'accent'] },
  },
} satisfies Meta<typeof Text>;

export default meta;

type Story = StoryObj<typeof meta>;

const HEADING_VARIANTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const PROSE_VARIANTS = ['body', 'bodySmall', 'note', 'caption', 'kicker'] as const;

// ── The scale ─────────────────────────────────────────────────────────────

/** The heading face at six steps: the whole scale, in order. */
export const HeadingScale: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {HEADING_VARIANTS.map((variant) => (
        <Text key={variant} variant={variant}>
          {variant} - Documents that tell the truth
        </Text>
      ))}
    </div>
  ),
};

/** The body face, for everything that is not a heading. */
export const ProseScale: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {PROSE_VARIANTS.map((variant) => (
        <Text key={variant} variant={variant} as="p">
          {variant} - A file is downloadable at clean but searchable only at indexed, and the
          interface says so.
        </Text>
      ))}
    </div>
  ),
};

// ── Individual variants ───────────────────────────────────────────────────

export const Heading1: Story = { args: { variant: 'h1' } };
export const Heading2: Story = { args: { variant: 'h2' } };
export const Heading3: Story = { args: { variant: 'h3' } };
export const Heading4: Story = { args: { variant: 'h4' } };
export const Heading5: Story = { args: { variant: 'h5' } };
export const Heading6: Story = { args: { variant: 'h6', children: 'Section label' } };
export const Body: Story = { args: { variant: 'body' } };
export const BodySmall: Story = { args: { variant: 'bodySmall' } };

/** The interface talking about itself: a field's hint, a validation line, a loading sentence. */
export const Note: Story = {
  args: { variant: 'note', children: 'Searchable once indexing finishes. Downloadable now.' },
};
export const Caption: Story = { args: { variant: 'caption', as: 'p' } };
export const Kicker: Story = { args: { variant: 'kicker', as: 'p', children: 'Contract' } };

// ── Tones ─────────────────────────────────────────────────────────────────

export const ToneDefault: Story = { args: { tone: 'default' } };

/** Muted copy comes from the muted role, which clears AA on either ground. */
export const ToneMuted: Story = { args: { tone: 'muted' } };

/**
 * The contrast rule, side by side. Only h1 and h2 clear WCAG's 24px large-text
 * threshold on the type scale, so only they carry the base accent; everything
 * from h3 down is pushed to the text-carrying step automatically.
 */
export const ToneAccent: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Text variant="h1" tone="accent">
        h1 - 40px, base accent, large enough
      </Text>
      <Text variant="h2" tone="accent">
        h2 - 28px, base accent, large enough
      </Text>
      <Text variant="h3" tone="accent">
        h3 - 22px, under the threshold, so accent-text
      </Text>
      <Text variant="h4" tone="accent">
        h4 - accent-text
      </Text>
      <Text variant="h5" tone="accent">
        h5 - accent-text
      </Text>
      <Text variant="h6" tone="accent">
        h6 - accent-text
      </Text>
      <Text variant="body" tone="accent">
        body - accent-text, because the base accent reads at about 3:1 on this ground
      </Text>
      <Text variant="bodySmall" tone="accent">
        bodySmall - accent-text
      </Text>
      <Text variant="note" tone="accent">
        note - accent-text
      </Text>
      <Text variant="caption" tone="accent" as="p">
        caption - accent-text
      </Text>
      <Text variant="kicker" tone="accent" as="p">
        kicker - accent-text
      </Text>
    </div>
  ),
};

/** All three tones on one variant, for comparison. */
export const AllTones: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Text tone="default">Default - the ink of the system.</Text>
      <Text tone="muted">Muted - secondary copy, still legible at AA.</Text>
      <Text tone="accent">Accent - body size, so the text-carrying step.</Text>
    </div>
  ),
};

/** The tag can be overridden for the outline without changing the look. */
export const TagOverride: Story = {
  args: { variant: 'h1', as: 'h2', children: 'Rendered as h2, sized as h1' },
};

// ── The other ground ──────────────────────────────────────────────────────

/** The summed channels of a computed `rgb(...)`, which is enough to order two colours by weight. */
function weight(color: string): number {
  return (color.match(/\d+/g) ?? [])
    .slice(0, 3)
    .reduce((total, channel) => total + Number(channel), 0);
}

/**
 * The canary for the whole dark-ground suite, and the reason it lives on the
 * type primitive: every other dark story asserts nothing about the ground and
 * simply lets axe measure it, so if `globals: { ground: 'dark' }` ever stopped
 * reaching the preview decorator, all of them would keep passing while quietly
 * measuring the light ground twice. This one story checks that the page really
 * did invert - light type on a dark page rather than the other way round - so
 * that failure mode is loud in exactly one place instead of silent in ten.
 */
async function expectInkGround(): Promise<void> {
  await expect(document.documentElement.dataset.theme).toBe('dark');

  const page = getComputedStyle(document.body);
  await expect(weight(page.backgroundColor)).toBeLessThan(weight(page.color));
}

/**
 * Every variant and every tone on ink. Nothing in this component knows which
 * ground it is on: `default`, `muted` and `accent` are roles, and the sheet
 * points them at the other end of their ramps. This story is here so axe
 * measures that claim rather than taking it.
 */
export const DarkGround: Story = {
  globals: { ground: 'dark' },
  parameters: { layout: 'padded' },
  play: expectInkGround,
  render: () => (
    <div className="flex flex-col gap-4">
      {HEADING_VARIANTS.map((variant) => (
        <Text key={variant} variant={variant}>
          {variant} - Documents that tell the truth
        </Text>
      ))}
      {PROSE_VARIANTS.map((variant) => (
        <Text key={variant} variant={variant} as="p">
          {variant} - a file is downloadable at clean but searchable only at indexed.
        </Text>
      ))}
      <Text tone="muted">Muted - neutral-400 on ink, where neutral-700 would vanish.</Text>
      <Text variant="h1" tone="accent">
        Accent at display size
      </Text>
      <Text tone="accent">Accent at body size - the text-carrying step, accent-300 here.</Text>
    </div>
  ),
};
