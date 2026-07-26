import { type Meta, type StoryObj } from '@storybook/react-vite';

import { Text, type TextVariant } from './Text';

/**
 * The type scale and the two tones a caller can choose.
 *
 * The accent tone is the interesting one: the same prop resolves to the base
 * accent at display size and to accent-700 at body size, because the
 * accent/ground pair is only about 3:1. axe checks that on every story below.
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
const PROSE_VARIANTS = ['body', 'bodySmall', 'caption', 'kicker'] as const;

// ── The scale ─────────────────────────────────────────────────────────────

/** Barlow Condensed at six steps: the whole heading scale, in order. */
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

/** Barlow for everything that is not a heading. */
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
export const Caption: Story = { args: { variant: 'caption', as: 'p' } };
export const Kicker: Story = { args: { variant: 'kicker', as: 'p', children: 'Contract' } };

// ── Tones ─────────────────────────────────────────────────────────────────

export const ToneDefault: Story = { args: { tone: 'default' } };

/** Muted copy comes from the neutral ramp, which clears AA at body size. */
export const ToneMuted: Story = { args: { tone: 'muted' } };

/**
 * The contrast rule, side by side. The display headings carry the base accent;
 * everything from h4 down is pushed to accent-700 automatically.
 */
export const ToneAccent: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Text variant="h1" tone="accent">
        h1 - base accent, large enough
      </Text>
      <Text variant="h2" tone="accent">
        h2 - base accent, large enough
      </Text>
      <Text variant="h3" tone="accent">
        h3 - base accent, large enough
      </Text>
      <Text variant="h4" tone="accent">
        h4 - accent-700
      </Text>
      <Text variant="h5" tone="accent">
        h5 - accent-700
      </Text>
      <Text variant="h6" tone="accent">
        h6 - accent-700
      </Text>
      <Text variant="body" tone="accent">
        body - accent-700, because the base accent reads at about 3:1 on this ground
      </Text>
      <Text variant="bodySmall" tone="accent">
        bodySmall - accent-700
      </Text>
      <Text variant="caption" tone="accent" as="p">
        caption - accent-700
      </Text>
      <Text variant="kicker" tone="accent" as="p">
        kicker - accent-700
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
      <Text tone="accent">Accent - body size, so accent-700.</Text>
    </div>
  ),
};

/** The tag can be overridden for the outline without changing the look. */
export const TagOverride: Story = {
  args: { variant: 'h1', as: 'h2', children: 'Rendered as h2, sized as h1' },
};
