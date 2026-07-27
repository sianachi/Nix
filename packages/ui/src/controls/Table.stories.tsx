import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Table, type TableColumn, type TableProps } from './Table';
import { Tag } from './Tag';

/**
 * The data table in each of the four things it can be saying: here are the rows, here are the
 * sorted rows, there are none, and I do not know yet.
 *
 * The last two are the pair worth staring at. They are different answers and they are drawn
 * differently on purpose - an empty body while a fetch is in flight reads as "no documents", which
 * is a fact the reader will act on before it is true.
 */

interface Document {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly state: 'Draft' | 'Published';
  readonly words: number;
}

const ROWS: Document[] = [
  { id: 'a', title: 'Onboarding guide', owner: 'A. Mensah', state: 'Published', words: 1240 },
  { id: 'b', title: 'Retention policy', owner: 'K. Oyelaran', state: 'Draft', words: 340 },
  { id: 'c', title: 'Q3 planning', owner: 'S. Adeyemi', state: 'Draft', words: 2870 },
];

const COLUMNS: TableColumn<Document>[] = [
  { key: 'title', header: 'Title', cell: (row) => row.title, sortable: true, rowHeader: true },
  { key: 'owner', header: 'Owner', cell: (row) => row.owner, sortable: true },
  {
    key: 'state',
    header: 'State',
    cell: (row) => <Tag tone={row.state === 'Published' ? 'accent' : 'neutral'}>{row.state}</Tag>,
  },
  {
    key: 'words',
    header: 'Words',
    cell: (row) => row.words.toLocaleString('en'),
    sortable: true,
    align: 'end',
  },
];

/**
 * The table pinned to one row type. A generic component's props infer with `unknown` rows, which
 * would take the type off every cell function in this file; naming the instantiation once puts it
 * back without a cast.
 */
const DocumentTable = Table<Document>;

const meta = {
  title: 'Controls/Table',
  component: DocumentTable,
  args: {
    caption: 'Documents in this workspace',
    columns: COLUMNS,
    rows: ROWS,
    rowKey: (row) => row.id,
    emptyMessage: 'No documents yet. Create one to get started.',
    onSortChange: fn(),
  },
  argTypes: {
    loading: { control: 'boolean' },
  },
  parameters: { layout: 'padded' },
} satisfies Meta<TableProps<Document>>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Rows, unsorted: every sortable header offers itself, none of them claims a direction. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('columnheader', { name: 'Title' }),
    ).toHaveAttribute('aria-sort', 'none');
  },
};

/** Sorted ascending on the title. The arrow and `aria-sort` say the same thing. */
export const SortedAscending: Story = {
  args: { sort: { columnKey: 'title', direction: 'ascending' } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('columnheader', { name: 'Title' }),
    ).toHaveAttribute('aria-sort', 'ascending');
  },
};

/** Sorted descending on a numeric column, which reads right-aligned. */
export const SortedDescending: Story = {
  args: { sort: { columnKey: 'words', direction: 'descending' } },
};

/**
 * Clicking the sorted column asks for the reverse of it - and nothing in the table moves, because
 * the sort belongs to the URL and this component only reports the intent.
 */
export const SortReversesOnSecondClick: Story = {
  args: { sort: { columnKey: 'title', direction: 'ascending' } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Title' }));

    await expect(args.onSortChange).toHaveBeenCalledWith({
      columnKey: 'title',
      direction: 'descending',
    });
  },
};

/** Clicking a different column starts it ascending rather than inheriting the old direction. */
export const SortMovesToAnotherColumn: Story = {
  args: { sort: { columnKey: 'title', direction: 'descending' } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Owner' }));

    await expect(args.onSortChange).toHaveBeenCalledWith({
      columnKey: 'owner',
      direction: 'ascending',
    });
  },
};

/** Keyboard: the header is a button, so Tab reaches it and Enter sorts. */
export const SortByKeyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const header = within(canvasElement).getByRole('button', { name: 'Title' });

    await userEvent.tab();
    await expect(header).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await expect(args.onSortChange).toHaveBeenCalled();
  },
};

/** Hover on a sortable header: the ink wash the whole library uses for a neutral control. */
export const SortableHeaderHover: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: 'Owner' }));
  },
};

/** No sort handler: the headers are plain text, because an offer nobody can accept is a lie. */
export const NotSortable: Story = {
  render: (args) => (
    <DocumentTable
      caption={args.caption}
      columns={args.columns}
      rows={args.rows}
      rowKey={args.rowKey}
      emptyMessage={args.emptyMessage}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button')).not.toBeInTheDocument();
  },
};

/** The answer arrived and it was none. The caller's own words, not a shrug. */
export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('No documents yet. Create one to get started.'),
    ).toBeInTheDocument();
  },
};

/** The answer has not arrived. Note what is *not* said here. */
export const Loading: Story = {
  args: { rows: [], loading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    await expect(
      canvas.queryByText('No documents yet. Create one to get started.'),
    ).not.toBeInTheDocument();
  },
};

/**
 * Refetching with rows already in hand - a sort change, say. The previous rows are stale, so the
 * table says it is working rather than showing an order that is about to be wrong.
 */
export const LoadingWithPreviousRows: Story = {
  args: { loading: true, loadingMessage: 'Reordering documents' },
};

/**
 * Rows on ink. Every colour the table draws with is a role or a wash of one -
 * the caption is muted, the headers are a foreground wash, the rules are the
 * divider - so the whole table crosses grounds without a variant of its own.
 */
export const DarkGround: Story = {
  args: { sort: { columnKey: 'title', direction: 'ascending' } },
  globals: { ground: 'dark' },
};

/** The empty answer on ink, since the message is muted copy and that is where muted copy fails. */
export const EmptyDark: Story = {
  args: { rows: [] },
  globals: { ground: 'dark' },
};

/** A table with one column and one row still owes the reader a caption and a header. */
export const SingleColumn: Story = {
  args: {
    columns: [{ key: 'title', header: 'Title', cell: (row) => row.title }],
    rows: ROWS.slice(0, 1),
  },
};
