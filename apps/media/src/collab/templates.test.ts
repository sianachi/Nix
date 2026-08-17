import { describe, expect, it } from 'vitest';

import type { ImportedTemplateRequest } from './templates.ts';
import { createTemplateImporter, parseManagedFinalizeRequest } from './templates.ts';

const REQUEST = {
  manifest: {},
  bundles: [],
  profile: {},
  digest: '0'.repeat(64),
  workspaceId: '10000000-0000-4000-8000-000000000001',
  origin: 'user',
  idempotencyKey: 'test',
} as unknown as ImportedTemplateRequest;

describe('the collaboration template client', () => {
  it('passes the request deadline signal to the exact preview validator call', async () => {
    const deadline = new AbortController();
    let received: AbortSignal | null | undefined;
    let url = '';
    const importer = createTemplateImporter({
      collabBaseUrl: 'https://collab.test',
      internalSecret: 'secret',
      fetch: (input, init) => {
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        received = init?.signal;
        return Promise.resolve(
          new Response(JSON.stringify({ itemCount: 0, bodyCount: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    await importer.validateTemplate('token', REQUEST, deadline.signal);

    expect(url).toBe('https://collab.test/templates/imports/validate');
    expect(received).toBe(deadline.signal);
  });

  it('refuses an authorization response that omits a capability decision', async () => {
    const importer = createTemplateImporter({
      collabBaseUrl: 'https://collab.test',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              workspaceId: '10000000-0000-4000-8000-000000000001',
              tenantId: '10000000-0000-4000-8000-000000000002',
              principalId: '10000000-0000-4000-8000-000000000003',
              canWrite: true,
            }),
          ),
        ),
    });

    await expect(
      importer.authorizePreview('token', '10000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({
      status: 502,
      code: 'template.collab_contract_invalid',
    });
  });

  it('refuses a successful stage response with an invalid digest', async () => {
    const importer = createTemplateImporter({
      collabBaseUrl: 'https://collab.test',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              operationId: null,
              templateId: '10000000-0000-4000-8000-000000000001',
              stableKey: 'managed.project',
              digest: 'short',
              unchanged: true,
              writtenTargetItemIds: [],
            }),
          ),
        ),
    });

    await expect(importer.stageTemplate('token', REQUEST)).rejects.toMatchObject({
      status: 502,
      code: 'template.collab_contract_invalid',
    });
  });

  it('refuses malformed managed-finalize requests before forwarding them', () => {
    expect(
      caught(() =>
        parseManagedFinalizeRequest({
          imports: [{ operationId: null }],
          activeStableKeys: [],
        }),
      ),
    ).toMatchObject({ status: 400, code: 'template.finalize_invalid' });
  });
});

function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the contract parser to refuse the value.');
}
