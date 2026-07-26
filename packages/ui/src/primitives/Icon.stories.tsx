import { type Meta, type StoryObj } from '@storybook/react-vite';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  FileText,
  Folder,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react';

import { Button } from '../controls/Button';
import { Icon, type IconSize } from './Icon';
import { Text } from './Text';

/**
 * Lucide at stroke-width 1.5, in three interface sizes. The stroke is not a
 * prop, so it cannot drift; the size set is closed, so call sites cannot
 * invent one.
 */
const meta = {
  title: 'Primitives/Icon',
  component: Icon,
  parameters: { layout: 'padded' },
  args: { icon: Search },
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] satisfies IconSize[] },
    icon: { control: false },
  },
} satisfies Meta<typeof Icon>;

export default meta;

type Story = StoryObj<typeof meta>;

const SET = [
  { icon: Search, name: 'Search' },
  { icon: Plus, name: 'Add' },
  { icon: FileText, name: 'Document' },
  { icon: Folder, name: 'Folder' },
  { icon: Upload, name: 'Upload' },
  { icon: Share2, name: 'Share' },
  { icon: Trash2, name: 'Delete' },
  { icon: Settings, name: 'Settings' },
  { icon: Clock, name: 'History' },
  { icon: Check, name: 'Done' },
  { icon: ChevronDown, name: 'Expand' },
  { icon: ArrowRight, name: 'Continue' },
];

/** Decorative by default: hidden from assistive technology. */
export const Decorative: Story = {
  args: { size: 'md' },
};

/** Given a label, the glyph becomes a named image. */
export const Labelled: Story = {
  args: { size: 'md', label: 'Search' },
};

export const SizeSmall: Story = { args: { size: 'sm', label: 'Search' } };
export const SizeMedium: Story = { args: { size: 'md', label: 'Search' } };
export const SizeLarge: Story = { args: { size: 'lg', label: 'Search' } };

/** The three interface sizes together. */
export const AllSizes: Story = {
  render: () => (
    <div className="flex items-end gap-8">
      {(['sm', 'md', 'lg'] satisfies IconSize[]).map((size) => (
        <div key={size} className="flex flex-col items-center gap-2">
          <Icon icon={Search} size={size} />
          <Text variant="caption" tone="muted" as="span">
            {size}
          </Text>
        </div>
      ))}
    </div>
  ),
};

/** The working set at interface size, all on one stroke weight. */
export const Set: Story = {
  render: () => (
    <div className="grid grid-cols-6 gap-6">
      {SET.map(({ icon, name }) => (
        <div key={name} className="flex flex-col items-center gap-2">
          <Icon icon={icon} />
          <Text variant="caption" tone="muted" as="span">
            {name}
          </Text>
        </div>
      ))}
    </div>
  ),
};

/** In buttons: decorative beside a label, named when it stands alone. */
export const InButtons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button variant="primary">
        <Icon icon={Upload} size="sm" />
        Upload
      </Button>
      <Button variant="secondary">
        <Icon icon={Share2} size="sm" />
        Share
      </Button>
      <Button variant="ghost">
        <Icon icon={ChevronDown} size="sm" />
        More
      </Button>
      <Button variant="icon" aria-label="Delete document">
        <Icon icon={Trash2} />
      </Button>
    </div>
  ),
};

/** Inline with text, taking the surrounding color. */
export const InlineWithText: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Icon icon={Clock} size="sm" />
      <Text variant="bodySmall" tone="muted" as="span">
        Indexed 4 minutes ago
      </Text>
    </div>
  ),
};
