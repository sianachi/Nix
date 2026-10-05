import { describe, expect, it } from 'vitest';

import { createCoreClient } from './client.ts';

describe('Core view snapshots', () => {
  it('preserves composition, filters and interactive form configuration for archive round trips', async () => {
    const client = createCoreClient({
      coreBaseUrl: 'https://core.test',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              default: 'responses',
              views: [
                {
                  id: 'responses',
                  name: 'Responses',
                  kind: 'list',
                  columns: ['status'],
                  groupBy: null,
                  groupOrder: [],
                  dateProperty: null,
                  sortBy: 'status',
                  sortDescending: true,
                  mode: null,
                  coverProperty: null,
                  endDateProperty: null,
                  cardSize: null,
                  filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
                  companionViewId: 'intake',
                  companionPlacement: 'beside',
                  interactiveForm: null,
                },
                {
                  id: 'intake',
                  name: 'Intake',
                  kind: 'interactive_form',
                  columns: [],
                  interactiveForm: {
                    pages: [
                      {
                        id: 'page-1',
                        title: 'Details',
                        description: 'Tell us more',
                        visibleWhen: [],
                        blocks: [
                          {
                            id: 'question-1',
                            kind: 'field',
                            propertyKey: 'status',
                            text: 'Status',
                            help: null,
                            required: true,
                            identityRole: null,
                            visibleWhen: [],
                          },
                        ],
                      },
                    ],
                    titleMode: 'field',
                    titleFieldBlockId: 'question-1',
                    confirmationTitle: 'Thank you',
                    confirmationMessage: 'Your response was saved.',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });

    const views = await client.getViews('token', 'item');

    expect(views).toMatchObject({
      default: 'responses',
      views: [
        {
          filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
          companionViewId: 'intake',
          companionPlacement: 'beside',
        },
        {
          interactiveForm: {
            pages: [{ blocks: [{ required: true, propertyKey: 'status' }] }],
            confirmationTitle: 'Thank you',
          },
        },
      ],
    });
  });
});
