import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

beforeEach(() => {
  signedIn();
  sessionStorage.clear();
});

describe('template file import', () => {
  it('validates and previews an archive before adding it to the library', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi();
    renderAt(<App />, '/templates/import');

    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
    });
    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));

    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getAllByRole('heading', { name: '3' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImports).toEqual(['abc123']);
    expect(writes.templateImportIdempotencyKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('requires another preview when the selected file changes before import', async () => {
    const user = userEvent.setup();
    stubCoreApi({ templateFileChanged: true });
    renderAt(<App />, '/templates/import');

    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
    });
    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));
    await screen.findByRole('heading', { name: 'Imported template' });
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(
      await screen.findByRole('alert', {
        name: '',
      }),
    ).toHaveTextContent(
      'The selected file changed after preview. Preview it again before importing.',
    );
    expect(screen.queryByRole('heading', { name: 'Imported template' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /validate file/i })).toBeEnabled();
  });

  it('keeps a recovered preview and attempt when the same file is selected again', async () => {
    const user = userEvent.setup();
    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
      lastModified: 1_786_867_200_000,
    });
    const attempt = 'a0000000-0000-4000-8000-000000000031';
    sessionStorage.setItem(
      'nix:template-import',
      JSON.stringify({
        preview: {
          profile: {
            kind: 'template',
            version: 1,
            key: 'imported-template',
            name: 'Imported template',
            description: 'Validated from disk.',
            includeBody: true,
            includeChildren: true,
          },
          digest: 'abc123',
          rootItemType: 'note',
          itemCount: 3,
          bodyCount: 3,
          viewCount: 1,
        },
        idempotencyKey: attempt,
        fileIdentity: {
          name: archive.name,
          size: archive.size,
          lastModified: archive.lastModified,
        },
      }),
    );
    const writes = stubCoreApi();
    renderAt(<App />, '/templates/import');

    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getByText(/recovered preview is ready/i)).toBeVisible();
    await user.upload(screen.getByLabelText('Template file'), archive);

    expect(screen.getByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getByRole('button', { name: /add to library/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /add to library/i }));
    expect(writes.templateImportIdempotencyKeys).toEqual([attempt]);
  });

  it('distinguishes a library access error from permission denial and offers retry', async () => {
    stubCoreApi({ templatesFail: true });
    renderAt(<App />, '/templates/import');

    expect(
      await screen.findByRole('heading', { name: 'Template library unavailable' }),
    ).toBeVisible();
    expect(screen.getByText(/templates could not be loaded/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByText(/you cannot add or change them/i)).not.toBeInTheDocument();
  });

  it('explains permission denial without presenting it as a retryable access error', async () => {
    stubCoreApi({ canManageTemplates: false });
    renderAt(<App />, '/templates/import');

    expect(
      await screen.findByRole('heading', { name: 'Template import unavailable' }),
    ).toBeVisible();
    expect(screen.getByText(/you cannot add or change them/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
