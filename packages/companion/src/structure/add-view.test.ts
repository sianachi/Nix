import { describe, expect, it } from 'vitest';
import { viewConfigurationSchema } from '@nix/api-client';
import { createFakePorts } from '../testing/fake-ports.js';
import { loadPreviewContext } from '../context.js';
import { describeToolCall } from '../preview.js';
import { runWorkspaceTool } from '../run.js';
import { workspaceToolSchema } from '../tool-args.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';

describe('additive view capacity preflight', () => {
  it('reports ten existing plus four new views as a typed problem and makes no Core write', async () => {
    const fake = createFakePorts();
    const views = Array.from({ length: 10 }, (_, i) =>
      viewConfigurationSchema.parse({
        id: `list-${String(i)}`,
        name: `Existing ${String(i)}`,
        kind: 'list',
      }),
    );
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? { declared: [], properties: [], inherit: true }
          : endpoint.operation === 'views.getConfigurations'
            ? {
                views,
                default: 'list-0',
                unrenderable: [],
                hideDocument: false,
                version: 'a'.repeat(64),
              }
            : { id: itemId, workspaceId, parentId: null, title: 'Tasks', type: 'note' },
      ),
    );
    const request = workspaceToolSchema.parse({
      operation: 'add_view',
      itemId,
      parentId: '',
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: JSON.stringify({
        views: Array.from({ length: 4 }, (_, i) => ({ kind: 'list', name: `Added ${String(i)}` })),
      }),
    });
    const preview = await loadPreviewContext(fake.ports, workspaceId, request, fake.signal);
    expect(describeToolCall(request, preview).problems).toContainEqual({
      path: 'views',
      code: 'view-capacity',
      message:
        'This item has 10 views and room for 2 more (12 total). Adding 4 would create 14; request at most 2.',
    });
    await expect(
      runWorkspaceTool(fake.ports, workspaceId, JSON.stringify(request), fake.signal, {
        fence: preview.fingerprint,
      }),
    ).rejects.toThrow();
    expect(fake.execute).not.toHaveBeenCalled();
  });
});
