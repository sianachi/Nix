import { describe, expect, it } from 'vitest';

import {
  deleteTemplate,
  listTemplates,
  preflightTemplate,
  templateById,
  templateItemById,
  templateKey,
  templateLibraryKey,
} from './templates.js';

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
const TEMPLATE_ID = 'a1111111-1111-4111-8111-111111111111';
const SOURCE_ID = 'a2111111-1111-4111-8111-111111111111';

describe('the templates resource', () => {
  it('owns every Core template URL and stable cache identity', () => {
    expect(listTemplates(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/templates`,
      cacheKey: templateLibraryKey(WORKSPACE_ID),
    });
    expect(templateById(TEMPLATE_ID)).toMatchObject({
      path: `/api/v1/templates/${TEMPLATE_ID}`,
      cacheKey: templateKey(TEMPLATE_ID),
    });
    expect(templateItemById(TEMPLATE_ID, SOURCE_ID)).toMatchObject({
      path: `/api/v1/templates/${TEMPLATE_ID}/items/${SOURCE_ID}`,
      cacheKey: [...templateKey(TEMPLATE_ID), 'items', SOURCE_ID],
    });
  });

  it('normalizes omitted preflight values to the nullable wire contract', () => {
    const endpoint = preflightTemplate(TEMPLATE_ID, { mode: 'create', title: 'Daily tracker' });

    expect(endpoint.body).toEqual({
      mode: 'create',
      targetItemId: null,
      parentItemId: null,
      title: 'Daily tracker',
    });
  });

  it('invalidates both detail and catalog after deletion', () => {
    const endpoint = deleteTemplate({
      id: TEMPLATE_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Delivery board',
      description: null,
      origin: 'user',
      revision: 1,
      includeBody: false,
      includeChildren: false,
      fieldCount: 0,
      viewCount: 0,
      childCount: 0,
      viewKinds: [],
      capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
      updatedAt: '2026-08-17T09:00:00+00:00',
    });

    expect(endpoint.invalidates).toEqual([
      templateKey(TEMPLATE_ID),
      templateLibraryKey(WORKSPACE_ID),
    ]);
  });
});
