import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentHistory } from '../../history/document-history';
import type { DocumentHistoryState } from '../../history/use-document-history';

/**
 * The seam between the history hook and the history sidebar.
 *
 * Each was built against the plan by a different hand; this checks the two translations the
 * adapter owns: the current document is fetched from the head sequence for the diff, and a
 * refusal from any action becomes the sentence the sidebar shows.
 */

const hook = vi.hoisted(() => ({ current: null as DocumentHistoryState | null }));

vi.mock('../../history/use-document-history', () => ({
  useDocumentHistory: () => {
    if (hook.current === null) throw new Error('no hook state');
    return hook.current;
  },
}));

const ITEM = 'a1111111-1111-4111-8111-111111111111';

function paragraph(text: string): Record<string, unknown> {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function state(overrides: Partial<DocumentHistoryState> = {}): DocumentHistoryState {
  return {
    revisions: [
      {
        seq: 12,
        fromSeq: 9,
        actorId: 'actor-aaaa-bbbb',
        startedAt: '2026-09-20T10:00:00Z',
        endedAt: '2026-09-20T10:05:00Z',
        updateCount: 4,
        name: null,
      },
    ],
    hasMore: false,
    loadMore: vi.fn(() => Promise.resolve()),
    namedVersions: [],
    headSeq: 12,
    loading: false,
    refusal: null,
    stateAt: vi.fn((seq: number) =>
      Promise.resolve({
        ok: true as const,
        value: { seq, document: paragraph(`state at ${String(seq)}`), plaintext: '', headSeq: 12 },
      }),
    ),
    restore: vi.fn(() => Promise.resolve({ ok: true as const, value: { headSeq: 13 } })),
    nameVersion: vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        refusal: { code: 'version_name_invalid', detail: 'That name is taken.' },
      }),
    ),
    removeName: vi.fn(() => Promise.resolve({ ok: true as const, value: true as const })),
    refresh: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

beforeEach(() => {
  hook.current = state();
});

describe('the document history panel', () => {
  it('fetches the head state once for the diff, and shows the revisions', async () => {
    render(<DocumentHistory itemId={ITEM} onClose={vi.fn()} />);

    expect(screen.getByRole('complementary', { name: 'History' })).toBeInTheDocument();
    await waitFor(() => {
      expect(hook.current?.stateAt).toHaveBeenCalledWith(12);
    });
    expect(hook.current?.stateAt).toHaveBeenCalledTimes(1);
  });

  it('shows the hook’s refusal as a sentence', () => {
    hook.current = state({
      refusal: { code: 'document_not_found', detail: 'No such document.' },
      headSeq: null,
      revisions: [],
    });
    render(<DocumentHistory itemId={ITEM} onClose={vi.fn()} />);

    expect(screen.getByText('No such document.')).toBeInTheDocument();
  });

  it('shows a refused action where the list is, and keeps the list', async () => {
    const user = userEvent.setup();
    render(<DocumentHistory itemId={ITEM} onClose={vi.fn()} />);

    // Name the current version; the stubbed hook refuses.
    await user.click(screen.getByRole('button', { name: /name current version/i }));
    await user.type(screen.getByRole('textbox'), 'Draft one');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByText('That name is taken.')).toBeInTheDocument();
    });
    expect(hook.current?.nameVersion).toHaveBeenCalledWith(12, 'Draft one');
  });
});
