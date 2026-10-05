import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  HistorySidebar,
  type HistoryNamedVersion,
  type HistoryRevision,
  type HistorySidebarProps,
  type HistoryStateAtSeq,
} from '../../history/history-sidebar';

function doc(text: string): unknown {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

const REVISIONS: readonly HistoryRevision[] = [
  {
    seq: 20,
    fromSeq: 18,
    actorId: 'aaaaaaaa-1111-4111-8111-111111111111',
    startedAt: '2026-09-21T10:00:00Z',
    endedAt: '2026-09-21T10:05:00Z',
    updateCount: 3,
    name: null,
  },
  {
    seq: 12,
    fromSeq: 10,
    actorId: 'bbbbbbbb-2222-4222-8222-222222222222',
    startedAt: '2026-09-20T09:00:00Z',
    endedAt: '2026-09-20T09:02:00Z',
    updateCount: 2,
    name: 'Draft complete',
  },
];

const NAMED_VERSIONS: readonly HistoryNamedVersion[] = [
  {
    seq: 12,
    name: 'Draft complete',
    createdBy: 'bbbbbbbb-2222-4222-8222-222222222222',
    createdAt: '2026-09-20T09:02:00Z',
  },
];

function baseProps(overrides: Partial<HistorySidebarProps> = {}): HistorySidebarProps {
  return {
    revisions: REVISIONS,
    hasMore: false,
    loadMore: vi.fn(),
    namedVersions: NAMED_VERSIONS,
    headSeq: 20,
    loading: false,
    refusal: null,
    currentDocument: doc('Current text.'),
    stateAt: vi.fn((seq: number): Promise<HistoryStateAtSeq | null> =>
      Promise.resolve({
        document: doc(`Text at ${String(seq)}.`),
        plaintext: `Text at ${String(seq)}.`,
      }),
    ),
    onRestore: vi.fn(),
    onName: vi.fn(),
    onRemoveName: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('HistorySidebar', () => {
  it('groups revisions by day and shows a name badge for a named revision', () => {
    render(<HistorySidebar {...baseProps()} />);

    expect(screen.getByText(/aaaaaaaa/)).toBeInTheDocument();
    expect(screen.getByText(/bbbbbbbb/)).toBeInTheDocument();
    expect(screen.getByText('Draft complete')).toBeInTheDocument();

    // Two different calendar days produce two day groups, each headed by its weekday - the one
    // part of the label whose word order and format do not vary by locale (unlike the date
    // itself, which reads "September 21, 2026" in en-US and "21 September 2026" in en-GB).
    // 2026-09-21 is a Monday and 2026-09-20 is a Sunday.
    expect(screen.getByText(/^Monday,/)).toBeInTheDocument();
    expect(screen.getByText(/^Sunday,/)).toBeInTheDocument();
  });

  it('loads state and shows a diff when a revision is selected', async () => {
    const user = userEvent.setup();
    const stateAt = vi.fn((): Promise<HistoryStateAtSeq | null> =>
      Promise.resolve({ document: doc('Text at 20.'), plaintext: 'Text at 20.' }),
    );
    render(<HistorySidebar {...baseProps({ stateAt })} />);

    await user.click(screen.getByRole('button', { name: /aaaaaaaa/ }));

    expect(stateAt).toHaveBeenCalledWith(20);
    await waitFor(() => {
      // Once in the read-only rendering of the revision, once in the diff list's removed entry.
      expect(screen.getAllByText('Text at 20.').length).toBeGreaterThan(0);
    });
    // The diff compares the selected revision's text against the current document, so the
    // current document's own text shows up as an added block.
    expect(screen.getByText('Current text.')).toBeInTheDocument();
  });

  it('requires confirmation before restoring', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(<HistorySidebar {...baseProps({ onRestore })} />);

    await user.click(screen.getByRole('button', { name: /aaaaaaaa/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    expect(onRestore).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith(20);
  });

  it('validates the name length and calls onName with a trimmed value', async () => {
    const user = userEvent.setup();
    const onName = vi.fn();
    render(<HistorySidebar {...baseProps({ onName })} />);

    await user.click(screen.getByRole('button', { name: /aaaaaaaa/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Name this version' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Name this version' }));

    const form = screen.getByRole('form', { name: 'Name this version' });
    const input = within(form).getByRole('textbox');
    const save = within(form).getByRole('button', { name: 'Save' });

    // Empty is invalid.
    await user.click(save);
    expect(onName).not.toHaveBeenCalled();
    expect(within(form).getByRole('alert')).toBeInTheDocument();

    // Over 120 characters is invalid.
    await user.type(input, 'x'.repeat(121));
    await user.click(save);
    expect(onName).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, '  Milestone  ');
    await user.click(save);
    expect(onName).toHaveBeenCalledWith(20, 'Milestone');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HistorySidebar {...baseProps({ onClose })} />);

    screen.getByRole('button', { name: 'Close history' }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a refusal message and a loading state', () => {
    const { rerender } = render(
      <HistorySidebar {...baseProps({ revisions: [], loading: true, refusal: null })} />,
    );
    expect(screen.getByText('Loading history…')).toBeInTheDocument();

    rerender(
      <HistorySidebar
        {...baseProps({ revisions: [], loading: false, refusal: 'History is unavailable.' })}
      />,
    );
    expect(screen.getByText('History is unavailable.')).toBeInTheDocument();
  });
});
