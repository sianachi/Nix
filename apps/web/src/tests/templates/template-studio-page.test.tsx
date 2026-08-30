import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, STUB_WORKSPACE, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

const SOURCE = item({
  id: 'a9999999-9999-4999-8999-999999999999',
  title: 'Team project',
});
const OTHER_DESTINATION = item({
  id: 'a8888888-8888-4888-8888-888888888888',
  title: 'Operations',
});
const KANBAN_TEMPLATE_ID = 'a1111111-1111-4111-8111-111111111111';
const CAPTURE_FIELD = {
  key: 'priority',
  label: 'Priority',
  type: 'text',
  options: [],
  required: false,
};
const CAPTURE_VIEW = {
  id: 'work-list',
  name: 'Work list',
  kind: 'list',
  columns: ['title', 'priority'],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  filters: [],
  companionViewId: null,
  companionPlacement: null,
  interactiveForm: null,
};

beforeEach(() => {
  signedIn();
  sessionStorage.clear();
});

describe('the template studio', () => {
  it('protects body and child data by default, then captures the choices explicitly made', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      items: [SOURCE],
      schemas: {
        [SOURCE.id]: {
          properties: [CAPTURE_FIELD],
          declared: [CAPTURE_FIELD],
          inherit: true,
        },
      },
      views: { [SOURCE.id]: { views: [CAPTURE_VIEW], default: CAPTURE_VIEW.id } },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(await screen.findByRole('heading', { name: 'Save as template' })).toBeVisible();
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Team project');
    const preview = await screen.findByLabelText('Template preview');
    await waitFor(() => {
      expect(within(preview).getByText('Fields').parentElement).toHaveTextContent('1');
      expect(within(preview).getByText('Views').parentElement).toHaveTextContent('1');
    });
    expect(within(preview).getByText('list')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const body = screen.getByRole('checkbox', { name: /include document content/i });
    const children = screen.getByRole('checkbox', { name: /include everything inside/i });
    expect(body).not.toBeChecked();
    expect(children).not.toBeChecked();
    await user.click(body);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Save template' }));

    expect(await screen.findByRole('heading', { name: 'Team project' })).toBeVisible();
    expect(screen.getByText('Content')).toBeVisible();
  });

  it('gives both narrow-screen template regions their own bounded scroller', async () => {
    stubCoreApi({ items: [SOURCE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    await screen.findByRole('heading', { name: 'Save as template' });
    const preview = await screen.findByLabelText('Template preview');
    expect(preview.previousElementSibling).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(preview).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'lg:flex-none');
  });

  it('recovers an unfinished draft for the same source item', async () => {
    sessionStorage.setItem(
      `nix:template-studio:${STUB_WORKSPACE.id}:capture:source:${SOURCE.id}`,
      JSON.stringify({
        scope: `source:${SOURCE.id}`,
        title: 'Recovered project template',
        description: 'Saved in this tab.',
        includeBody: true,
        includeChildren: false,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000000',
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    stubCoreApi({ items: [SOURCE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue(
      'Recovered project template',
    );
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Saved in this tab.');
  });

  it('does not recover a studio draft saved for another workspace', async () => {
    const otherWorkspace = {
      ...STUB_WORKSPACE,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Other workspace',
      kind: 'shared' as const,
    };
    sessionStorage.setItem(
      `nix:template-studio:${STUB_WORKSPACE.id}:capture:source:${SOURCE.id}`,
      JSON.stringify({
        scope: `source:${SOURCE.id}`,
        title: 'Private draft from workspace A',
        description: '',
        includeBody: true,
        includeChildren: false,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000000',
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    stubCoreApi({ items: [SOURCE], workspaces: [STUB_WORKSPACE, otherWorkspace] });
    renderAt(<App />, `/w/${otherWorkspace.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Team project');
    expect(screen.queryByDisplayValue('Private draft from workspace A')).not.toBeInTheDocument();
  });

  it('offers a retry when template access cannot be checked', async () => {
    stubCoreApi({ items: [SOURCE], templatesFail: true });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(
      await screen.findByRole('heading', { name: 'Template access could not be checked' }),
    ).toBeVisible();
    expect(await screen.findByText(/template library could not be loaded/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Template creation unavailable' }),
    ).not.toBeInTheDocument();
  });

  it('checks conflicts before a direct rail jump can reach review', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({
      items: [SOURCE],
      templatePreflightCanApply: false,
      templatePreflightConflicts: ['A Status field already exists.'],
    });
    renderAt(<App />, `/items/${SOURCE.id}/templates/apply/${KANBAN_TEMPLATE_ID}`);

    expect(await screen.findByRole('heading', { name: 'Apply Kanban' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Review/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A Status field already exists.');
    expect(screen.queryByRole('heading', { name: 'Review' })).not.toBeInTheDocument();
    expect(writes.templatePreflights).toEqual([
      { mode: 'merge', targetItemId: SOURCE.id, parentItemId: null, title: null },
    ]);
  });

  it('keeps recovered apply drafts isolated to their exact target item', async () => {
    const user = userEvent.setup();
    const previousKey = 'a0000000-0000-4000-8000-000000000001';
    const sourceScope = `template:${KANBAN_TEMPLATE_ID}:target:${SOURCE.id}`;
    sessionStorage.setItem(
      `nix:template-studio:apply:template:${KANBAN_TEMPLATE_ID}:target:${OTHER_DESTINATION.id}`,
      JSON.stringify({
        scope: sourceScope,
        title: 'Kanban',
        description: '',
        includeBody: false,
        includeChildren: false,
        idempotencyKey: previousKey,
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    const writes = stubCoreApi({ items: [SOURCE, OTHER_DESTINATION] });
    renderAt(<App />, `/items/${OTHER_DESTINATION.id}/templates/apply/${KANBAN_TEMPLATE_ID}`);

    expect(await screen.findByRole('heading', { name: 'Apply Kanban' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Apply template' }));

    expect(writes.templateApplications).toHaveLength(1);
    expect(writes.templateApplications[0]).toMatchObject({
      templateId: KANBAN_TEMPLATE_ID,
      mode: 'merge',
      targetItemId: OTHER_DESTINATION.id,
    });
    expect(writes.templateApplications[0]?.idempotencyKey).not.toBe(previousKey);
  });

  it('keeps recovered create drafts isolated to their exact parent destination', async () => {
    const user = userEvent.setup();
    const previousKey = 'a0000000-0000-4000-8000-000000000002';
    const rootScope = `template:${KANBAN_TEMPLATE_ID}:parent:root`;
    sessionStorage.setItem(
      `nix:template-studio:create:template:${KANBAN_TEMPLATE_ID}:parent:${OTHER_DESTINATION.id}`,
      JSON.stringify({
        scope: rootScope,
        title: 'Wrong recovered title',
        description: '',
        includeBody: false,
        includeChildren: false,
        idempotencyKey: previousKey,
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    const writes = stubCoreApi({ items: [OTHER_DESTINATION] });
    renderAt(
      <App />,
      `/w/${STUB_WORKSPACE.id}/templates/${KANBAN_TEMPLATE_ID}/create?parent=${OTHER_DESTINATION.id}`,
    );

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Kanban');
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create item' }));

    expect(writes.templateApplications).toHaveLength(1);
    expect(writes.templateApplications[0]).toMatchObject({
      templateId: KANBAN_TEMPLATE_ID,
      mode: 'create',
      parentItemId: OTHER_DESTINATION.id,
      title: 'Kanban',
    });
    expect(writes.templateApplications[0]?.idempotencyKey).not.toBe(previousKey);
  });
});
