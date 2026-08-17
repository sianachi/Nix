import { describe, expect, it } from 'vitest';

import { createCoreTemplateClient } from './core.ts';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const SOURCE = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';

describe('the Core template client', () => {
  it('saves a draft with an empty POST rather than a browser-supplied write set', async () => {
    let requestedUrl = '';
    let requested: RequestInit | undefined;
    const client = createCoreTemplateClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'secret',
      fetch: (input, init) => {
        requestedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested = init;
        return Promise.resolve(new Response(JSON.stringify({ templateId: TEMPLATE })));
      },
    });

    await client.saveDraft('token', TEMPLATE, OPERATION);

    expect(requestedUrl).toBe(
      `https://core.test/internal/templates/${TEMPLATE}/drafts/${OPERATION}/save`,
    );
    expect(requested?.method).toBe('POST');
    expect(requested?.body).toBeUndefined();
    expect(new Headers(requested?.headers).has('content-type')).toBe(false);
  });

  it('preserves a null operation identifier on an unchanged import response', async () => {
    const client = createCoreTemplateClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              operationId: null,
              templateId: TEMPLATE,
              unchanged: true,
              bodyWrites: [],
              itemMappings: [],
            }),
          ),
        ),
    });

    await expect(client.beginImport('token', {})).resolves.toMatchObject({
      operationId: null,
      unchanged: true,
    });
  });

  it('refuses a successful Core response that does not satisfy the operation contract', async () => {
    const client = createCoreTemplateClient({
      coreBaseUrl: 'https://core.test',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              operationId: null,
              templateId: TEMPLATE,
              unchanged: 'yes',
              bodyWrites: [],
              itemMappings: [],
            }),
          ),
        ),
    });

    await expect(client.beginImport('token', {})).rejects.toMatchObject({
      status: 502,
      code: 'template.core_contract_invalid',
    });
  });

  it('deeply parses schema and stored views in a Core draft response', async () => {
    const client = draftClient(draftResponse());

    const result = await client.beginDraft('token', TEMPLATE, 'draft-one');

    expect(result.root.schema).toEqual({
      properties: [PROPERTY],
      declared: [PROPERTY],
      inherit: false,
    });
    expect(result.root.views).toMatchObject({
      default: 'list',
      views: [{ id: 'list', columns: [], groupOrder: [], filters: [] }],
    });
  });

  it('maps a malformed nested draft schema from begin to a stable upstream contract error', async () => {
    const client = draftClient(
      draftResponse({
        schema: {
          properties: [PROPERTY],
          declared: [{ ...PROPERTY, options: 'not-options' }],
          inherit: false,
        },
      }),
    );

    await expect(client.beginDraft('token', TEMPLATE, 'draft-one')).rejects.toMatchObject({
      status: 502,
      code: 'template.core_contract_invalid',
    });
  });

  it('maps a malformed nested draft view from get to a stable upstream contract error', async () => {
    const client = draftClient(
      draftResponse({
        views: {
          default: 'list',
          views: [{ id: 'list', name: 'List', kind: 'list', columns: 'not-columns' }],
        },
      }),
    );

    await expect(client.getDraft('token', TEMPLATE, OPERATION)).rejects.toMatchObject({
      status: 502,
      code: 'template.core_contract_invalid',
    });
  });

  it('maps a malformed nested draft form from patch to a stable upstream contract error', async () => {
    const client = draftClient(
      draftResponse({
        views: {
          default: 'form',
          views: [
            {
              id: 'form',
              name: 'Form',
              kind: 'interactive_form',
              interactiveForm: { pages: 'not-pages' },
            },
          ],
        },
      }),
    );

    await expect(client.patchDraft('token', TEMPLATE, OPERATION, {})).rejects.toMatchObject({
      status: 502,
      code: 'template.core_contract_invalid',
    });
  });

  it('expands and parses nested stored Interactive Form views from Core', async () => {
    const client = exportClient({
      default: 'form',
      views: [
        {
          id: 'form',
          name: 'Daily tracker',
          kind: 'interactive_form',
          interactiveForm: {
            pages: [
              {
                id: 'page-1',
                title: 'Today',
                blocks: [
                  {
                    id: 'mood',
                    kind: 'field',
                    propertyKey: 'mood',
                    text: 'How are you?',
                    help: null,
                    required: true,
                    identityRole: null,
                  },
                ],
              },
            ],
            titleMode: 'field',
            titleFieldBlockId: 'mood',
            confirmationTitle: 'Recorded',
            confirmationMessage: 'Your response was saved.',
          },
        },
      ],
    });

    const result = await client.getTemplateExport('token', TEMPLATE);

    expect(result.items[0]?.views?.views[0]).toMatchObject({
      columns: [],
      groupOrder: [],
      filters: [],
      interactiveForm: {
        pages: [
          {
            description: null,
            visibleWhen: [],
            blocks: [{ id: 'mood', visibleWhen: [] }],
          },
        ],
      },
    });
  });

  it('maps malformed nested Core export forms to a stable upstream contract error', async () => {
    const client = exportClient({
      views: [
        {
          id: 'form',
          name: 'Daily tracker',
          kind: 'interactive_form',
          interactiveForm: { pages: 'not-pages' },
        },
      ],
    });

    await expect(client.getTemplateExport('token', TEMPLATE)).rejects.toMatchObject({
      status: 502,
      code: 'template.core_contract_invalid',
    });
  });
});

const PROPERTY = {
  key: 'mood',
  label: 'Mood',
  type: 'text',
  options: [],
  required: false,
} as const;

function draftResponse(
  rootChanges: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    operationId: OPERATION,
    templateId: TEMPLATE,
    title: 'Daily tracker',
    description: null,
    expiresAt: '2026-08-18T10:00:00.000Z',
    root: {
      sourceId: SOURCE,
      itemType: 'note',
      title: 'Daily tracker',
      seq: '1',
      properties: {},
      schema: { properties: [PROPERTY], declared: [PROPERTY], inherit: false },
      views: {
        default: 'list',
        views: [{ id: 'list', name: 'List', kind: 'list' }],
      },
      hasBody: false,
      children: [],
      ...rootChanges,
    },
    itemMappings: [],
    bodyCopies: [],
  };
}

function draftClient(response: Readonly<Record<string, unknown>>) {
  return createCoreTemplateClient({
    coreBaseUrl: 'https://core.test',
    internalSecret: 'secret',
    fetch: () => Promise.resolve(new Response(JSON.stringify(response))),
  });
}

function exportClient(views: unknown) {
  return createCoreTemplateClient({
    coreBaseUrl: 'https://core.test',
    internalSecret: 'secret',
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            templateId: TEMPLATE,
            workspaceId: WORKSPACE,
            stableKey: 'daily-tracker',
            title: 'Daily tracker',
            description: null,
            origin: 'user',
            revision: 1,
            includeBody: false,
            includeChildren: false,
            items: [
              {
                sourceId: SOURCE,
                parentSourceId: null,
                itemId: ITEM,
                itemType: 'note',
                title: 'Daily tracker',
                seq: '1',
                properties: {},
                schema: {
                  properties: [
                    {
                      key: 'mood',
                      label: 'Mood',
                      type: 'text',
                      options: [],
                      required: false,
                    },
                  ],
                  inherit: false,
                },
                views,
                hasBody: false,
              },
            ],
          }),
        ),
      ),
  });
}
