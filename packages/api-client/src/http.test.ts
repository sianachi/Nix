import { HttpResponse, delay, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { NixErrorCode, NixErrorKind } from './errors.js';
import { createHttpTransport, withErrorMapping } from './http.js';
import { captureFailure } from './testing/failure.js';
import { TEST_BASE_URL, server, testUrl } from './testing/server.js';

function transport(timeoutMs = 15_000): ReturnType<typeof createHttpTransport> {
  return createHttpTransport({ baseUrl: TEST_BASE_URL, timeoutMs });
}

describe('the http transport', () => {
  it('sends JSON requests against the configured base url and returns the parsed body', async () => {
    server.use(
      http.post(testUrl('/items'), async ({ request }) => {
        expect(request.headers.get('content-type')).toContain('application/json');
        return HttpResponse.json({ echoed: await request.json() }, { status: 201 });
      }),
    );

    const response = await transport().send({
      method: 'POST',
      path: '/items',
      body: { title: 'Kickoff' },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ echoed: { title: 'Kickoff' } });
  });

  it('serialises query parameters and drops the ones that are undefined', async () => {
    const seen: string[] = [];
    server.use(
      http.get(testUrl('/items'), ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json([]);
      }),
    );

    await transport().send({
      method: 'GET',
      path: '/items',
      query: { limit: 25, cursor: undefined, archived: false },
    });

    expect(seen).toEqual(['?limit=25&archived=false']);
  });

  it('reports an empty 204 body as undefined rather than an empty string', async () => {
    server.use(http.delete(testUrl('/items/abc'), () => new HttpResponse(null, { status: 204 })));

    const response = await transport().send({ method: 'DELETE', path: '/items/abc' });

    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });

  it('surfaces a non-2xx status as data so the layers above can react to it', async () => {
    server.use(http.get(testUrl('/items/abc'), () => new HttpResponse(null, { status: 401 })));

    const response = await transport().send({ method: 'GET', path: '/items/abc' });

    expect(response.status).toBe(401);
  });

  it('rejects a path that is not relative to the base url', async () => {
    await expect(
      transport().send({ method: 'GET', path: 'https://elsewhere.example/items' }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('transport failures', () => {
  it('maps a dropped connection onto a network error', async () => {
    server.use(http.get(testUrl('/items'), () => HttpResponse.error()));

    const error = await captureFailure(transport().send({ method: 'GET', path: '/items' }));

    expect(error.kind).toBe(NixErrorKind.Network);
    expect(error.code).toBe(NixErrorCode.Network);
  });

  it('maps an exceeded time budget onto a timeout error distinct from a network error', async () => {
    server.use(
      http.get(testUrl('/slow'), async () => {
        await delay(200);
        return HttpResponse.json({});
      }),
    );

    const error = await captureFailure(transport(20).send({ method: 'GET', path: '/slow' }));

    expect(error.kind).toBe(NixErrorKind.Timeout);
    expect(error.code).toBe(NixErrorCode.Timeout);
  });

  it('maps an aborted signal onto a cancellation that callers can tell apart from a fault', async () => {
    server.use(
      http.get(testUrl('/slow'), async () => {
        await delay(500);
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();

    const pending = captureFailure(
      transport().send({ method: 'GET', path: '/slow', signal: controller.signal }),
    );
    controller.abort();
    const error = await pending;

    expect(error.kind).toBe(NixErrorKind.Canceled);
    expect(error.code).toBe(NixErrorCode.Canceled);
  });
});

describe('error mapping', () => {
  it('maps a problem details response onto a NixApiError that keeps the stable code', async () => {
    server.use(
      http.get(testUrl('/items/missing'), () =>
        HttpResponse.json(
          {
            type: 'https://nix.example/problems/item-not-found',
            title: 'Item not found',
            status: 404,
            detail: 'No item with that id exists in this workspace.',
            code: 'item.not_found',
            traceId: '00-abc-def-01',
          },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const client = withErrorMapping(transport(), undefined);

    const error = await captureFailure(client.send({ method: 'GET', path: '/items/missing' }));

    expect(error.kind).toBe(NixErrorKind.Problem);
    expect(error.code).toBe('item.not_found');
    expect(error.status).toBe(404);
    expect(error.title).toBe('Item not found');
    expect(error.detail).toBe('No item with that id exists in this workspace.');
    expect(error.traceId).toBe('00-abc-def-01');
  });

  it('carries validation errors from a problem details response onto the typed error', async () => {
    server.use(
      http.post(testUrl('/items'), () =>
        HttpResponse.json(
          {
            title: 'Validation failed',
            status: 422,
            code: 'item.invalid',
            errors: { title: ['Title is required.'], parentId: ['Parent must exist.'] },
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const client = withErrorMapping(transport(), undefined);

    const error = await captureFailure(client.send({ method: 'POST', path: '/items', body: {} }));

    expect(error.code).toBe('item.invalid');
    expect(error.validationErrors).toEqual({
      title: ['Title is required.'],
      parentId: ['Parent must exist.'],
    });
  });

  it('falls back to a status code error when the failure is not a problem document', async () => {
    server.use(
      http.get(testUrl('/items'), () => new HttpResponse('<html>gateway</html>', { status: 502 })),
    );
    const client = withErrorMapping(transport(), undefined);

    const error = await captureFailure(client.send({ method: 'GET', path: '/items' }));

    expect(error.kind).toBe(NixErrorKind.Http);
    expect(error.code).toBe('http.502');
    expect(error.status).toBe(502);
  });

  it('reports a malformed problem document as telemetry and still fails with the status code', async () => {
    server.use(
      http.get(testUrl('/items'), () =>
        HttpResponse.json(
          { title: 'Something broke' },
          { status: 500, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    const onParseError = vi.fn();
    const client = withErrorMapping(transport(), { onParseError });

    const error = await captureFailure(client.send({ method: 'GET', path: '/items' }));

    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('http.500');
  });

  it('reports failing requests to telemetry with the stable code but stays quiet about cancellations', async () => {
    server.use(
      http.get(testUrl('/items'), () =>
        HttpResponse.json(
          { title: 'Nope', status: 403, code: 'item.forbidden' },
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
      http.get(testUrl('/slow'), async () => {
        await delay(500);
        return HttpResponse.json({});
      }),
    );
    const onRequestError = vi.fn();
    const client = withErrorMapping(transport(), { onRequestError });

    await client.send({ method: 'GET', path: '/items' }).catch(() => undefined);
    const controller = new AbortController();
    const pending = client
      .send({ method: 'GET', path: '/slow', signal: controller.signal })
      .catch(() => undefined);
    controller.abort();
    await pending;

    expect(onRequestError).toHaveBeenCalledTimes(1);
    expect(onRequestError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'item.forbidden', status: 403, method: 'GET' }),
    );
  });
});
