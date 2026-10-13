import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpHandler } from './mcp-http.ts';
import type { FetchImpl } from './session.ts';

const API = 'https://core.test';
const seen: { authorization: string | null; path: string }[] = [];

const fetchImpl: FetchImpl = (input, init) => {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  seen.push({ authorization: headers.get('authorization'), path: url.pathname });
  if (url.pathname.endsWith('/public/v1/auth/token')) {
    return Promise.resolve(
      Response.json({ accessToken: 'jwt-for-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
    );
  }
  if (url.pathname.endsWith('/api/v1/items/11111111-1111-4111-8111-111111111111')) {
    return Promise.resolve(
      Response.json({
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        parentId: null,
        type: 'note',
        title: 'Remote note',
        seq: 1,
        hasChildren: false,
        lifecycleState: 'active',
        properties: {},
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    );
  }
  return Promise.resolve(Response.json({ code: 'not_found' }, { status: 404 }));
};

let server: Server | null = null;
const realFetch = globalThis.fetch;
// The Nix client speaks through the global fetch; Core's host is answered by the fake above and
// everything else (this test's own loopback server) goes to the real one.
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  return url.host === 'core.test' ? fetchImpl(url.toString(), init) : realFetch(input, init);
});

async function listen(): Promise<URL> {
  const handler = createMcpHttpHandler({ apiUrl: API, fetchImpl });
  const created = createServer((request, response) => {
    void handler(request, response);
  });
  server = created;
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  const address = created.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return new URL(`http://127.0.0.1:${String(address.port)}/mcp`);
}

afterEach(async () => {
  seen.length = 0;
  const current = server;
  server = null;
  await new Promise<void>((resolve) => {
    if (current === null) resolve();
    else
      current.close(() => {
        resolve();
      });
  });
});

describe('nixctl mcp over HTTP', () => {
  it('refuses a request without a personal access token before building any tool server', async () => {
    const url = await listen();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(seen).toEqual([]);
    const health = await fetch(new URL('/healthz', url));
    expect(health.status).toBe(200);
  });

  it('serves the tool contract to a bearer and reaches Core as that token alone', async () => {
    const url = await listen();
    const client = new Client({ name: 'remote-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer nixpat_remote_owner' } },
    });
    // The SDK's own transport, typed with optional setters this project's strictness refuses.
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain('read_note');
      expect(names).toContain('list_workspaces');
      expect(JSON.stringify(tools)).not.toContain('nixpat_');

      const result = await client.callTool({
        name: 'get_item',
        arguments: { itemId: '11111111-1111-4111-8111-111111111111' },
      });
      expect(JSON.stringify(result)).toContain('Remote note');
      // The PAT was exchanged once and Core saw the minted JWT, never the PAT on an API route.
      const exchange = seen.filter((call) => call.path.endsWith('/public/v1/auth/token'));
      expect(exchange).toHaveLength(1);
      const apiCalls = seen.filter((call) => call.path.startsWith('/api/'));
      expect(apiCalls.length).toBeGreaterThan(0);
      expect(apiCalls.every((call) => call.authorization === 'Bearer jwt-for-owner')).toBe(true);
    } finally {
      await client.close();
    }
  });
});
