import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExportDialog } from './export-dialog';
import * as archive from './export-archive';

const ITEM = 'c1000000-0000-4000-8000-000000000031';

function result(overrides: Partial<archive.ArchiveResult> = {}): archive.ArchiveResult {
  return {
    fileName: 'notes.nix',
    blob: new Blob(['zip']),
    itemCount: 3,
    omittedCount: 0,
    ...overrides,
  };
}

function open(props: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  const onClose = vi.fn();

  render(
    <ExportDialog
      open
      itemId={ITEM}
      hasChildren
      getAccessToken={() => Promise.resolve('token')}
      onClose={onClose}
      {...props}
    />,
  );

  return { onClose };
}

beforeEach(() => {
  // The download itself is the browser's business; what matters here is that the dialog asked for
  // one and reported what it got.
  vi.spyOn(archive, 'saveArchive').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the export dialog', () => {
  it('offers the scope choice only when there is something inside to include', () => {
    open({ hasChildren: false });

    expect(screen.queryByRole('group', { name: 'What to export' })).not.toBeInTheDocument();
  });

  it('asks what to export when the item has children', () => {
    open();

    expect(screen.getByRole('group', { name: 'What to export' })).toBeInTheDocument();
  });

  it('says it is working rather than looking like nothing happened', async () => {
    // Never resolves: the assertion is about what the dialog shows while it is waiting.
    vi.spyOn(archive, 'requestArchive').mockImplementation(
      () => new Promise<archive.ArchiveOutcome>(() => undefined),
    );

    open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByRole('button', { name: 'Preparing…' })).toBeDisabled();
  });

  it('closes once a complete archive has been handed over', async () => {
    vi.spyOn(archive, 'requestArchive').mockResolvedValue({ ok: true, value: result() });

    const { onClose } = open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(archive.saveArchive).toHaveBeenCalled();
  });

  it('stays open and says what was left out when the archive is partial', async () => {
    vi.spyOn(archive, 'requestArchive').mockResolvedValue({
      ok: true,
      value: result({ itemCount: 42, omittedCount: 6 }),
    });

    const { onClose } = open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('42 items were exported');
    expect(notice).toHaveTextContent('6 were left out');
    // The file was still produced - a partial archive is a real archive, and refusing to hand it
    // over would lose the 42 items that did export.
    expect(archive.saveArchive).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a refusal in the service’s own words', async () => {
    vi.spyOn(archive, 'requestArchive').mockResolvedValue({
      ok: false,
      error: 'That item is no longer available to you.',
    });

    const { onClose } = open();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That item is no longer available to you.',
    );
    expect(archive.saveArchive).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets somebody try again after a refusal', async () => {
    const request = vi
      .spyOn(archive, 'requestArchive')
      .mockResolvedValueOnce({ ok: false, error: 'Nope.' })
      .mockResolvedValueOnce({ ok: true, value: result() });

    open();

    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
  });
});
