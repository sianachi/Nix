import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';

import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import { MESSAGE_NOTICE, CLOSE_CODES } from './protocol.ts';
import { attachWebSocketServer, type JoinResult, type SessionHub, type SocketSession } from './server.ts';
import { createSessionAuthenticator } from './session-auth.ts';

/**
 * The handshake, exercised over real sockets against a real `ws` server and nothing else -
 * no Fastify, no database. What is under test is the contract G20 states: a connection
 * without permission is refused with the right close code, the user's token is forwarded to
 * the authorizer verbatim, and a revocation reaches a live socket within its bound.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

const GRANTED: ItemAuthorization = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
};

const VALID_TOKENS: TokenValidator = {
  validate: (token) =>
    Promise.resolve(token === 'forged' ? null : { subject: 'someone', expiresAt: null }),
};

function acceptingHub(): SessionHub & { joined: SocketSession[]; messages: Uint8Array[] } {
  const joined: SocketSession[] = [];
  const messages: Uint8Array[] = [];
  return {
    joined,
    messages,
    join(session: SocketSession): Promise<JoinResult> {
      joined.push(session);
      return Promise.resolve({ ok: true, docId: 'd1000000-0000-4000-8000-000000000041', schemaVersion: 1 });
    },
    handleMessage(_session, data): void {
      messages.push(data);
    },
    leave(): void {
      // Nothing to release in a test hub.
    },
  };
}

interface Harness {
  readonly url: string;
  readonly server: HttpServer;
}

const servers: HttpServer[] = [];
const sockets: WebSocket[] = [];

async function listen(options: {
  authorizer?: Authorizer;
  tokens?: TokenValidator;
  hub?: SessionHub;
  reauthMs?: number;
  authTimeoutMs?: number;
  cacheTtlMs?: number;
}): Promise<Harness> {
  const server = createHttpServer();
  servers.push(server);

  attachWebSocketServer(server, {
    sessions: createSessionAuthenticator({
      tokens: options.tokens ?? VALID_TOKENS,
      authorizer: options.authorizer ?? { authorize: () => Promise.resolve(GRANTED) },
      cacheTtlMs: options.cacheTtlMs ?? 1,
    }),
    hub: options.hub ?? acceptingHub(),
    reauthMs: options.reauthMs ?? 60_000,
    authTimeoutMs: options.authTimeoutMs,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not bind a port.');
  }

  return { url: `ws://127.0.0.1:${String(address.port)}`, server };
}

function connect(url: string, itemId: string = ITEM): WebSocket {
  const socket = new WebSocket(`${url}/documents/${itemId}/ws`);
  sockets.push(socket);
  return socket;
}

function closedWith(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.on('close', (code) => {
      resolve(code);
    });
  });
}

function nextMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (data, isBinary) => {
      resolve({ data: data as Buffer, isBinary });
    });
  });
}

function authFrame(token: string): string {
  return JSON.stringify({ type: 'auth', token, schemaVersion: 1 });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

describe('the websocket handshake', () => {
  it('refuses a connection that never authenticates, within the timeout', async () => {
    const { url } = await listen({ authTimeoutMs: 50 });
    const socket = connect(url);

    expect(await closedWith(socket)).toBe(CLOSE_CODES.unauthenticated);
  });

  it('refuses a first frame that is not the auth frame', async () => {
    const { url } = await listen({});
    const socket = connect(url);
    socket.on('open', () => {
      socket.send('hello');
    });

    expect(await closedWith(socket)).toBe(CLOSE_CODES.unauthenticated);
  });

  it('refuses a token that does not validate, without asking Core', async () => {
    let asked = 0;
    const { url } = await listen({
      authorizer: {
        authorize: () => {
          asked += 1;
          return Promise.resolve(GRANTED);
        },
      },
    });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('forged'));
    });

    expect(await closedWith(socket)).toBe(CLOSE_CODES.unauthenticated);
    expect(asked).toBe(0);
  });

  it('refuses a connection without read permission', async () => {
    const { url } = await listen({ authorizer: { authorize: () => Promise.resolve(null) } });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('valid'));
    });

    expect(await closedWith(socket)).toBe(CLOSE_CODES.notFound);
  });

  it('answers a path that is not the endpoint with plain HTTP, never an upgrade', async () => {
    const { url } = await listen({});
    const socket = new WebSocket(`${url}/somewhere/else`);
    sockets.push(socket);

    const failed = await new Promise<boolean>((resolve) => {
      socket.on('error', () => {
        resolve(true);
      });
      socket.on('open', () => {
        resolve(false);
      });
    });

    expect(failed).toBe(true);
  });

  it('forwards the user token to the authorizer verbatim and answers ready', async () => {
    const forwarded: string[] = [];
    const { url } = await listen({
      authorizer: {
        authorize: (token) => {
          forwarded.push(token);
          return Promise.resolve(GRANTED);
        },
      },
    });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('the-user-token'));
    });

    const ready = JSON.parse((await nextMessage(socket)).data.toString('utf8')) as Record<string, unknown>;

    expect(forwarded).toEqual(['the-user-token']);
    expect(ready).toMatchObject({
      type: 'ready',
      docId: 'd1000000-0000-4000-8000-000000000041',
      mode: 'write',
      bodyKind: 'note',
      schemaVersion: 1,
    });
  });

  it('tells a reader they are a reader in the handshake answer', async () => {
    const { url } = await listen({
      authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite: false }) },
    });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('valid'));
    });

    const ready = JSON.parse((await nextMessage(socket)).data.toString('utf8')) as Record<string, unknown>;

    expect(ready).toMatchObject({ mode: 'read' });
  });

  it('relays the hub refusal as the close code, schema pin included', async () => {
    const refusingHub: SessionHub = {
      join: () =>
        Promise.resolve({
          ok: false,
          closeCode: CLOSE_CODES.schemaMismatch,
          reason: 'This document is pinned to a newer schema.',
        }),
      handleMessage() {
        // Refused sessions never deliver messages.
      },
      leave() {
        // Nothing to release in a test hub.
      },
    };
    const { url } = await listen({ hub: refusingHub });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('valid'));
    });

    expect(await closedWith(socket)).toBe(CLOSE_CODES.schemaMismatch);
  });

  it('routes binary frames to the hub once the session is established', async () => {
    const hub = acceptingHub();
    const { url } = await listen({ hub });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('valid'));
    });
    await nextMessage(socket);

    socket.send(new Uint8Array([7, 8, 9]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hub.messages).toEqual([new Uint8Array([7, 8, 9])]);
  });

  it('closes a live socket whose authorization was revoked, within the re-check bound', async () => {
    let granted = true;
    const { url } = await listen({
      authorizer: { authorize: () => Promise.resolve(granted ? GRANTED : null) },
      reauthMs: 25,
    });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('valid'));
    });
    await nextMessage(socket);

    granted = false;

    expect(await closedWith(socket)).toBe(CLOSE_CODES.revoked);
  });

  it('downgrades a live writer to a reader with a notice, not a disconnect', async () => {
    let canWrite = true;
    const { url } = await listen({
      authorizer: { authorize: () => Promise.resolve({ ...GRANTED, canWrite }) },
      reauthMs: 25,
    });
    const socket = connect(url);
    socket.on('open', () => {
      socket.send(authFrame('valid'));
    });
    await nextMessage(socket);

    canWrite = false;
    const notice = await nextMessage(socket);

    expect(notice.isBinary).toBe(true);
    const decoder = decoding.createDecoder(new Uint8Array(notice.data));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_NOTICE);
    expect(JSON.parse(decoding.readVarString(decoder))).toMatchObject({ code: 'read_only' });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
