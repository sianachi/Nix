import { type Meta, type StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';

import { Card } from '../controls/Card';
import { blueprintFrame } from './Blueprint';
import { Duotone } from './Duotone';
import { Text } from './Text';

/**
 * A stand-in cover, drawn rather than fetched.
 *
 * The component's contract asks callers for an absolute http/https URL, and a real gallery passes
 * one. A story cannot: a remote image makes the library's stories - and the axe run over them -
 * depend on a network and on somebody else's uptime, which is the same argument the app makes for
 * self-hosting its typeface. So the plate is inline, and it is deliberately a full tonal range
 * from black through to white so the mapping onto the two tones is visible rather than asserted.
 *
 * Its greys are named CSS colours, not tokens, because they are not design values: they stand in
 * for the pixels of somebody's photograph, and a photograph's pixels never came from the sheet.
 */
const PLATE = `data:image/svg+xml,${encodeURIComponent(
  [
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'>",
    "<defs><linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>",
    "<stop offset='0' stop-color='black'/>",
    "<stop offset='0.6' stop-color='gray'/>",
    "<stop offset='1' stop-color='gainsboro'/>",
    '</linearGradient></defs>',
    "<rect width='320' height='200' fill='url(#sky)'/>",
    "<circle cx='236' cy='56' r='24' fill='white'/>",
    "<path d='M0 148 L72 104 L130 148 L198 92 L268 148 L320 116 L320 200 L0 200 Z' fill='dimgray'/>",
    "<path d='M0 170 L88 132 L166 174 L244 136 L320 176 L320 200 L0 200 Z' fill='gray'/>",
    "<path d='M0 190 L120 166 L222 192 L320 168 L320 200 L0 200 Z' fill='black'/>",
    '</svg>',
  ].join(''),
)}`;

/**
 * A cover with an alpha channel, on nothing. The filter clips both tones to the source's own alpha
 * so transparency survives the treatment; without that clip the shadow flood fills the whole box
 * and every transparent cover gains a solid accent-900 background. The opaque plate above cannot
 * show that branch, which is the only reason this one exists.
 */
const CUTOUT_PLATE = `data:image/svg+xml,${encodeURIComponent(
  [
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>",
    "<circle cx='100' cy='100' r='84' fill='black'/>",
    "<circle cx='100' cy='100' r='54' fill='gray'/>",
    "<circle cx='100' cy='100' r='24' fill='white'/>",
    '</svg>',
  ].join(''),
)}`;

/**
 * A source that fails immediately and without a resolver: the bytes are not a PNG, so the decode
 * fails in-process. A hostname that does not exist would depend on DNS behaving the same way on
 * every machine that runs the suite, and would settle after axe had already looked.
 */
const BROKEN_COVER = 'data:image/png;base64,x';

/**
 * The image treatment: luminance mapped onto a deep steel shadow and a near-neutral highlight, so
 * a wall of arbitrary user covers reads as one surface. The two tones are ramp steps rather than
 * semantic roles, on purpose - see the component - so the plate below looks identical on both
 * grounds while everything around it inverts.
 */
const meta = {
  title: 'Primitives/Duotone',
  component: Duotone,
  parameters: { layout: 'padded' },
  args: {
    src: PLATE,
    alt: 'Hills below a low sun',
    className: 'h-40 w-72 object-cover',
  },
} satisfies Meta<typeof Duotone>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The treatment, on an image whose alt text carries something the page does not already say.
 *
 * It wears a frame because it sits on the ground rather than on a surface: the highlight tone is
 * 1.03:1 against paper, so a pale cover - a screenshot of a document, which this product is full
 * of - would have no edge at all. On `bg-surface` the surface change is the edge and no frame is
 * wanted, which is why the component does not carry one. See `Gallery`.
 */
export const Default: Story = {
  args: { className: `h-40 w-72 object-cover ${blueprintFrame}` },
};

/**
 * An empty alt: the caller is saying the surrounding text already names this, so the image leaves
 * the accessibility tree entirely rather than announcing a filename or a shrug.
 */
export const Decorative: Story = {
  args: { alt: '', className: `h-40 w-72 object-cover ${blueprintFrame}` },
};

/**
 * Above the fold, where deferring the fetch would only delay the first thing a reader sees. Every
 * other instance keeps the `lazy` default, because a gallery is the first screen in this product
 * to ask for N remote images and nothing virtualizes it.
 */
export const Eager: Story = {
  args: { loading: 'eager', className: `h-40 w-72 object-cover ${blueprintFrame}` },
};

/**
 * A cover with transparency. Both tones are clipped to the source's own alpha, so the ground reads
 * through the cut-out instead of the shadow flood filling the box.
 */
export const TransparentSource: Story = {
  args: {
    src: CUTOUT_PLATE,
    alt: '',
    className: 'h-40 w-40 object-contain',
  },
};

/**
 * The same plate treated and untreated. The untreated one is a bare `<img>` and the only one in
 * the library: it is a reference print, not an example to copy - images in the product go through
 * `<Duotone>`.
 */
export const BesideTheUntreatedPlate: Story = {
  render: (args) => (
    <div className="flex items-start gap-6">
      <figure className="flex flex-col gap-2">
        <img src={args.src} alt="" className={`block h-40 w-72 object-cover ${blueprintFrame}`} />
        <figcaption>
          <Text variant="caption" tone="muted" as="span">
            Untreated
          </Text>
        </figcaption>
      </figure>
      <figure className="flex flex-col gap-2">
        <Duotone {...args} alt="" className={`h-40 w-72 object-cover ${blueprintFrame}`} />
        <figcaption>
          <Text variant="caption" tone="muted" as="span">
            Duotone
          </Text>
        </figcaption>
      </figure>
    </div>
  ),
};

/**
 * What the component was built for: several covers at once. Each instance carries its own filter,
 * so nothing here depends on which card mounted first or on which one is still mounted. No frames:
 * a card is `bg-surface`, and the surface change already says where the cover ends.
 */
export const Gallery: Story = {
  render: (args) => (
    <div className="grid grid-cols-3 gap-6">
      {['Harbour survey', 'Site photography', 'Cover sheet'].map((title) => (
        <Card key={title} kicker="Gallery" title={title} headingLevel={3} className="gap-3 p-3">
          <Duotone {...args} alt="" className="h-32 w-full rounded-sm object-cover" />
          <Text variant="bodySmall" tone="muted">
            Three instances, three filters, one treatment.
          </Text>
        </Card>
      ))}
    </div>
  ),
};

/**
 * The treatment on ink. The plate is identical to the light ground and that is the point: the
 * cards, the copy and the frames around it all invert, and the photograph does not, because its
 * luminance is content rather than chrome.
 */
export const DarkGround: Story = {
  globals: { ground: 'dark' },
  render: (args) => (
    <div className="grid grid-cols-2 gap-6">
      {['Harbour survey', 'Site photography'].map((title) => (
        <Card key={title} kicker="Gallery" title={title} headingLevel={3} className="gap-3 p-3">
          <Duotone {...args} alt="" className="h-32 w-full rounded-sm object-cover" />
          <Text variant="bodySmall" tone="muted">
            The same two tones, on the other ground.
          </Text>
        </Card>
      ))}
    </div>
  ),
};

/** The three sentences a gallery has to keep apart, and which of them this component knows. */
type CoverState = 'none-configured' | 'unset' | 'broken' | 'ok';

const COVER_MESSAGE: Record<'none-configured' | 'unset' | 'broken', string> = {
  'none-configured': 'This view shows no cover.',
  unset: 'No cover has been chosen for this item.',
  broken: 'This cover could not be loaded.',
};

/**
 * What a caller does with `onError`.
 *
 * The component reports the failure and adds nothing: no placeholder, no wording of its own. It
 * *replaces* the image rather than covering it, which matters - a failed `<img>` is not blank, and
 * a caller that leaves one in the tree has shipped the browser's broken-image chrome instead of
 * this sentence.
 *
 * Only the caller can tell the three states apart, and only the last one reaches `<Duotone>` at
 * all: the other two are decided before there is a URL to render.
 */
function GalleryCover({
  state,
  title,
}: {
  readonly state: CoverState;
  readonly title: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const message = state !== 'ok' ? COVER_MESSAGE[state] : failed ? COVER_MESSAGE.broken : undefined;

  return (
    <Card title={title} headingLevel={3} className="w-64 gap-3 p-3">
      {message === undefined ? (
        <Duotone
          src={state === 'ok' ? BROKEN_COVER : PLATE}
          alt=""
          className="h-32 w-full rounded-sm object-cover"
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        <div className="flex h-32 w-full items-center justify-center rounded-sm bg-background p-3">
          <Text variant="bodySmall" tone="muted">
            {message}
          </Text>
        </div>
      )}
    </Card>
  );
}

/**
 * The three states side by side. `<Duotone>` is only ever involved in the third, which is the whole
 * argument for it having no opinion about any of them.
 */
export const TheThreeAbsences: Story = {
  render: () => (
    <div className="flex items-start gap-6">
      <GalleryCover state="none-configured" title="Board" />
      <GalleryCover state="unset" title="Draft agreement" />
      <GalleryCover state="ok" title="Harbour survey" />
    </div>
  ),
  play: async ({ canvas }) => {
    // Without this, axe measures the story before the decode fails and never sees the third
    // sentence - the one state this component exists to hand over.
    await canvas.findByText(COVER_MESSAGE.broken, undefined, { timeout: 5000 });
  },
};

/** The same three on ink, where the caller's own wording still has to read. */
export const TheThreeAbsencesOnInk: Story = {
  globals: { ground: 'dark' },
  render: () => (
    <div className="flex items-start gap-6">
      <GalleryCover state="none-configured" title="Board" />
      <GalleryCover state="unset" title="Draft agreement" />
      <GalleryCover state="ok" title="Harbour survey" />
    </div>
  ),
  play: async ({ canvas }) => {
    await canvas.findByText(COVER_MESSAGE.broken, undefined, { timeout: 5000 });
  },
};
