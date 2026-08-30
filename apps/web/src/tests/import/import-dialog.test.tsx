import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MARKDOWN_IMPORT_SCAN } from '@nix/markdown/scan';

import { ImportDialog } from '../../import/import-dialog';
import * as run from '../../import/import-run';

// The dialog reaches the client only through the run seam, which these tests stub; the hook is
// stubbed so rendering does not need the whole provider stack.
vi.mock('../../api/api-client-provider', () => ({
  useApiClient: () => ({}) as unknown,
}));

vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: '00000000-0000-4000-8000-000000000001' }),
}));

const PARENT = 'c1000000-0000-4000-8000-000000000031';

function report(overrides: Partial<run.ImportRunReport> = {}): run.ImportRunReport {
  return {
    rootItemId: 'r1000000-0000-4000-8000-000000000001',
    created: [
      {
        path: 'vault',
        itemId: 'r1000000-0000-4000-8000-000000000001',
        title: 'vault',
        scan: EMPTY_MARKDOWN_IMPORT_SCAN,
        droppedFrontMatter: [],
      },
      {
        path: 'vault/a.md',
        itemId: 'a1000000-0000-4000-8000-000000000002',
        title: 'a',
        scan: EMPTY_MARKDOWN_IMPORT_SCAN,
        droppedFrontMatter: [],
      },
    ],
    failed: [],
    notAttempted: [],
    stoppedEarly: false,
    ...overrides,
  };
}

function open(props: Partial<Parameters<typeof ImportDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onImported = vi.fn();

  render(
    <ImportDialog
      open
      parentId={PARENT}
      getAccessToken={() => Promise.resolve('token')}
      onClose={onClose}
      onImported={onImported}
      {...props}
    />,
  );

  return { onClose, onImported };
}

async function pick(...files: File[]): Promise<void> {
  // applyAccept off so the "picked the wrong thing" case can actually arrive, the way a folder
  // pick delivers every file type regardless of the file input's accept.
  await userEvent.upload(screen.getByLabelText('Markdown files to import'), files, {
    applyAccept: false,
  });
}

function markdownFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/markdown' });
}

function vaultFile(path: string, text: string): File {
  const file = markdownFile(path.split('/').at(-1) ?? 'note.md', text);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the import dialog', () => {
  it('says what it can import - and what it cannot yet - before anything is chosen', () => {
    open();

    expect(screen.getByText(/Obsidian vault/)).toBeInTheDocument();
    expect(screen.getByText(/folders containing Markdown notes/)).toBeInTheDocument();
    expect(
      screen.getByText(/Headings, lists, tables and inline formatting are kept/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Simple front matter fields/)).toBeInTheDocument();
    expect(screen.getByText(/Archives, Word and PDF cannot be imported yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeInTheDocument();
  });

  it('previews an Obsidian vault recursively, preserving its nested folders', async () => {
    open();
    await pick(
      vaultFile('Research vault/Daily/2026-08-22.md', 'Today.'),
      vaultFile('Research vault/Projects/Nix.md', 'Project.'),
      vaultFile('Research vault/.obsidian/config.md', 'Tool settings.'),
    );

    expect(await screen.findByRole('button', { name: 'Import 5 items' })).toBeInTheDocument();
    expect(screen.getByText(/under a new item called “Research vault”/)).toBeInTheDocument();
    expect(screen.getByText(/inside a hidden directory/)).toHaveTextContent(
      'Research vault/.obsidian/config.md',
    );
    expect(
      screen.queryByRole('heading', { name: 'Review before importing' }),
    ).not.toBeInTheDocument();
    const live = screen
      .getAllByRole('status')
      .find((status) => status.textContent.startsWith('Preview ready:'));
    expect(live).toHaveTextContent('Preview ready: 5 items to import. 1 file will be skipped.');
    expect(live).not.toHaveTextContent('content change');
  });

  it('previews each parser-observed content change separately before creating anything', async () => {
    const spy = vi.spyOn(run, 'runImportPlan');

    open();
    await pick(
      markdownFile(
        'a.md',
        '---\ntitle: Named\n- not simple\n---\nA [[Link]], ![[photo.png]], ![local](./photo.png), inline ![web](https://example.test/photo.png), and ![unsupported](nix://image/x).',
      ),
      markdownFile('b.md', 'Plain.'),
    );

    expect(await screen.findByRole('button', { name: /Import 3 items/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review before importing' })).toBeInTheDocument();
    expect(screen.getByText(/1 wiki link will stay as text/)).toHaveTextContent('a.md');
    expect(screen.getByText(/1 Obsidian embed will stay as/)).toHaveTextContent('a.md');
    expect(screen.getByText(/1 local picture path will be kept/)).toHaveTextContent('a.md');
    expect(screen.getByText(/1 picture address cannot be displayed safely/)).toHaveTextContent(
      'a.md',
    );
    expect(screen.getByText(/1 inline picture will no longer display/)).toHaveTextContent('a.md');
    expect(screen.getByText(/1 unsupported front matter line will be left out/)).toHaveTextContent(
      'a.md',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Preview ready: 3 items to import. 6 content changes need review.',
    );
    // Nothing ran: the preview is a plan, not a receipt.
    expect(spy).not.toHaveBeenCalled();
  });

  it('announces one content change with singular agreement', async () => {
    open();
    await pick(markdownFile('a.md', 'A [[Link]].'));

    expect(await screen.findByRole('button', { name: /Import 2 items/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Preview ready: 2 items to import. 1 content change needs review.',
    );
  });

  it('hands Markdown tables to the import run as editor table nodes', async () => {
    const spy = vi.spyOn(run, 'runImportPlan').mockResolvedValue(report());

    open();
    await pick(
      markdownFile('comparison.md', '| Project | Status |\n| :--- | ---: |\n| Nix | Ready |'),
    );
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    const options = spy.mock.calls[0]?.[0];
    const note = options?.plan.children[0];
    expect(note?.kind).toBe('note');
    expect(JSON.stringify(note?.doc)).toContain('"type":"table"');
    expect(JSON.stringify(note?.doc)).toContain('"type":"tableHeader"');
    expect(JSON.stringify(note?.doc)).toContain('"align":"right"');
  });

  it('offers a way back from the preview without closing the dialog', async () => {
    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose different files' }));

    expect(await screen.findByRole('button', { name: 'Choose files' })).toBeInTheDocument();
  });

  it('reports a clean run as whole, and hands the root to the shell', async () => {
    vi.spyOn(run, 'runImportPlan').mockResolvedValue(report());

    const { onImported } = open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    expect((await screen.findAllByText('2 items were created.')).length).toBeGreaterThan(0);
    expect(onImported).toHaveBeenCalledWith('r1000000-0000-4000-8000-000000000001');
    expect(screen.getByRole('button', { name: 'Undo import' })).toBeEnabled();
  });

  it('reports content changes only for items that were actually created', async () => {
    vi.spyOn(run, 'runImportPlan').mockResolvedValue(
      report({
        created: [
          {
            path: 'vault/imported.md',
            itemId: 'a1000000-0000-4000-8000-000000000002',
            title: 'imported',
            scan: {
              unresolvedWikiLinks: 0,
              unresolvedObsidianEmbeds: 1,
              unresolvedLocalImages: 0,
              unsupportedImageAddresses: 0,
              inlineImagesFlattened: 0,
            },
            droppedFrontMatter: [],
          },
        ],
        notAttempted: [{ path: 'vault/not-imported.md', reason: 'cancelled' }],
        stoppedEarly: true,
      }),
    );

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    expect(
      screen.getByRole('heading', { name: 'Changes in imported content' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/1 Obsidian embed was kept as/)).toHaveTextContent(
      'vault/imported.md',
    );
    expect(screen.getByText(/1 item was not attempted/)).toHaveTextContent('vault/not-imported.md');
    expect(screen.getByText(/1 Obsidian embed was kept as/)).not.toHaveTextContent(
      'not-imported.md',
    );
  });

  it('does not claim body mapping changes when that body was not written', async () => {
    vi.spyOn(run, 'runImportPlan').mockResolvedValue(
      report({
        created: [
          {
            path: 'vault/refused.md',
            itemId: 'a1000000-0000-4000-8000-000000000002',
            title: 'refused',
            scan: {
              unresolvedWikiLinks: 1,
              unresolvedObsidianEmbeds: 1,
              unresolvedLocalImages: 1,
              unsupportedImageAddresses: 1,
              inlineImagesFlattened: 1,
            },
            droppedFrontMatter: ['- unsupported'],
            bodyError: 'collab refused the body',
          },
        ],
      }),
    );

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    expect(await screen.findByText(/lost part of its content/)).toHaveTextContent(
      'collab refused the body',
    );
    expect(screen.getByText(/1 unsupported front matter line was left out/)).toHaveTextContent(
      'vault/refused.md',
    );
    expect(screen.queryByText(/wiki link stayed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Obsidian embed was kept/)).not.toBeInTheDocument();
    expect(screen.queryByText(/picture address could/)).not.toBeInTheDocument();
  });

  it('offers Stop while the run is in flight, and renders the stopped report', async () => {
    let finish: (value: run.ImportRunReport) => void = () => undefined;
    vi.spyOn(run, 'runImportPlan').mockImplementation(
      () =>
        new Promise<run.ImportRunReport>((resolve) => {
          finish = resolve;
        }),
    );

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    // Mid-run: the only action is stopping; pressing it must not strand the dialog.
    const stop = await screen.findByRole('button', { name: 'Stop import' });
    await userEvent.click(stop);
    finish(
      report({
        stoppedEarly: true,
        stopReason: 'The import was cancelled.',
        notAttempted: [{ path: 'b.md', reason: 'cancelled' }],
      }),
    );

    expect((await screen.findAllByText(/not everything made it across/)).length).toBeGreaterThan(0);
    expect(screen.getByText('The import was cancelled.')).toBeInTheDocument();
  });

  it('reports a partial run as partial, naming the items each reason covers', async () => {
    vi.spyOn(run, 'runImportPlan').mockResolvedValue(
      report({
        failed: [{ path: 'vault/broken.md', reason: 'boom' }],
        notAttempted: [{ path: 'vault/late.md', reason: 'stopped at the write rate limit' }],
        stoppedEarly: true,
        stopReason: 'The workspace is rate-limiting writes.',
      }),
    );

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    expect((await screen.findAllByText(/not everything made it across/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/rate-limiting writes/)).toBeInTheDocument();
    expect(screen.getByText(/1 item failed - boom: vault\/broken\.md\./)).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 item was not attempted - stopped at the write rate limit: vault\/late\.md\./,
      ),
    ).toBeInTheDocument();
  });

  it('renders a run that could not start as an error with a retry, not a partial', async () => {
    const spy = vi.spyOn(run, 'runImportPlan').mockResolvedValue(
      report({
        rootItemId: null,
        created: [],
        couldNotStart: 'Your session has expired. Sign in again to import.',
      }),
    );

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/session has expired/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('lands on an error, not a frozen spinner, when the run itself breaks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(run, 'runImportPlan').mockRejectedValue(new Error('a bug'));

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed unexpectedly/);
    // The way out is back, not a reload: the pick controls are live again.
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeEnabled();
  });

  it('undoes an import by soft-deleting its root, and says the result is restorable', async () => {
    vi.spyOn(run, 'runImportPlan').mockResolvedValue(report());
    const undo = vi.spyOn(run, 'undoImport').mockResolvedValue({ ok: true });

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo import' }));

    expect(undo).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-4000-8000-000000000001',
      'r1000000-0000-4000-8000-000000000001',
    );
    expect(await screen.findByText(/they can be restored/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undone' })).toBeDisabled();
  });

  it('says when an undo was refused, keeping the refusal words', async () => {
    vi.spyOn(run, 'runImportPlan').mockResolvedValue(report());
    vi.spyOn(run, 'undoImport').mockResolvedValue({ ok: false, error: 'not yours to delete' });

    open();
    await pick(markdownFile('a.md', 'Body.'));
    await userEvent.click(await screen.findByRole('button', { name: /Import 2 items/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not yours to delete');
  });

  it('says when nothing importable was chosen instead of showing an empty preview', async () => {
    open();
    await pick(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing importable was chosen/);
  });
});
