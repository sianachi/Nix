import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { CollabMetrics } from '../metrics.ts';
import { CLOSE_CODES, encodeNotice, parseAuthFrame } from './protocol.ts';
import type { SessionAuthenticator, SessionAuthorization } from './session-auth.ts';

/**
 * One authenticated socket, as the document layer sees it.
 *
 * `mode` is mutable on purpose: a revocation re-check can downgrade a writer to a reader
 * mid-session without tearing the socket down, which is the honest middle ground between
 * "a socket outlives its permission" and "every permission change is a disconnect".
 */
export interface SocketSession {
  readonly socket: WebSocket;
  readonly itemId: string;
  readonly clientSchemaVersion: number;

  /**
   * The user's own bearer token, held for the session's service-to-service calls - the
   * touched notification forwards it so Core acts as this principal, never as a service.
   */
  readonly token: string;
  authorization: SessionAuthorization;
  mode: 'write' | 'read';
}

/** What a hub says to a handshake: serve it, or close it with a reason. */
export type JoinResult =
  | { readonly ok: true; readonly docId: string; readonly schemaVersion: number }
  | { readonly ok: false; readonly closeCode: number; readonly reason: string };

/**
 * Where authenticated sockets go. The handshake below is transport plumbing; everything
 * document-shaped - loading, sync, awareness, flushing - lives behind this seam, so the
 * lifecycle layer replaces the hub without touching how a connection is established.
 */
export interface SessionHub {
  join(session: SocketSession): Promise<JoinResult>;
  handleMessage(session: SocketSession, data: Uint8Array): void;
  leave(session: SocketSession): void;

  /**
   * Called after the ready frame is on the wire, so anything the hub sends - sync step 1,
   * the awareness roster - arrives after the client knows the session stands.
   */
  ready?(session: SocketSession): void;

  /** Drains whatever the hub holds. Called on server close, after the sockets are told. */
  shutdown?(): Promise<void>;
}

export interface WebSocketOptions {
  readonly sessions: SessionAuthenticator;
  readonly hub: SessionHub;

  /** How often a live session's authorization is re-checked. */
  readonly reauthMs: number;

  /** How long the client has to send its auth frame. Defaults to ten seconds. */
  readonly authTimeoutMs?: number | undefined;

  /** Keepalive ping interval. A socket that misses one is dead, not idle. */
  readonly pingMs?: number | undefined;

  readonly metrics?: CollabMetrics | undefined;
}

const WS_PATH = /^\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ws$/i;

/**
 * Attaches the WebSocket endpoint to an HTTP server: `GET /documents/:itemId/ws`, upgraded.
 *
 * **The handshake authorizes before anything else happens.** The first frame must be the
 * auth frame; until it arrives and Core says yes, no document is loaded, no state is sent,
 * and nothing the client transmits is interpreted. Every refusal is a close code from
 * `CLOSE_CODES`, chosen so the client can tell "get a new token" from "you cannot have
 * this" from "try again later" - and nothing more.
 */
export function attachWebSocketServer(
  httpServer: HttpServer,
  options: WebSocketOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const authTimeoutMs = options.authTimeoutMs ?? 10_000;
  const pingMs = options.pingMs ?? 30_000;

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = WS_PATH.exec(new URL(request.url ?? '/', 'http://placeholder').pathname);
    if (match === null) {
      // Refused before the upgrade completes: a path that is not the endpoint gets HTTP's
      // answer, not a WebSocket close code on a connection that should never have opened.
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const itemId = (match[1] ?? '').toLowerCase();
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, itemId, options, authTimeoutMs, pingMs);
    });
  });

  return wss;
}

function handleConnection(
  socket: WebSocket,
  itemId: string,
  options: WebSocketOptions,
  authTimeoutMs: number,
  pingMs: number,
): void {
  const { sessions, hub, metrics } = options;

  let session: SocketSession | null = null;
  let token: string | null = null;
  let alive = true;

  metrics?.openSockets.inc();

  // The clock starts at accept: a socket that connects and says nothing is holding a file
  // descriptor hostage, and after this it is not.
  const authTimer = setTimeout(() => {
    close(CLOSE_CODES.unauthenticated, 'No auth frame arrived in time.');
  }, authTimeoutMs);

  const pinger = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, pingMs);

  // Re-checked on a wall-clock timer, not on traffic: an idle socket held by a
  // deprovisioned principal is exactly the leak the re-check exists to close.
  const reauthTimer = setInterval(() => {
    void recheck();
  }, options.reauthMs);

  socket.on('pong', () => {
    alive = true;
  });

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (session === null) {
      void establish(data, isBinary);
      return;
    }

    if (!isBinary) {
      // After the handshake the protocol is binary; a stray text frame is a client bug,
      // ignored rather than fatal so a logging line gone astray cannot end a session.
      return;
    }

    hub.handleMessage(session, toUint8Array(data));
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    clearInterval(pinger);
    clearInterval(reauthTimer);
    metrics?.openSockets.dec();
    if (session !== null) {
      const parting = session;
      session = null;
      hub.leave(parting);
    }
  });

  socket.on('error', () => {
    // 'close' follows and does the cleanup; an unhandled 'error' event would kill the
    // process, which is the only reason this handler exists.
  });

  async function establish(data: RawData, isBinary: boolean): Promise<void> {
    const frame = parseAuthFrame(isBinary ? null : rawDataToString(data));
    if (frame === null) {
      close(CLOSE_CODES.unauthenticated, 'The first frame must be the auth frame.');
      return;
    }

    const result = await sessions.authenticate(frame.token, itemId);
    if (!result.ok) {
      if (result.reason === 'unauthenticated') {
        close(CLOSE_CODES.unauthenticated, 'The token could not be validated.');
      } else {
        close(CLOSE_CODES.notFound, 'No such document.');
      }
      return;
    }

    const authorization = result.value;
    const candidate: SocketSession = {
      socket,
      itemId,
      clientSchemaVersion: frame.schemaVersion,
      token: frame.token,
      authorization,
      mode: authorization.canWrite ? 'write' : 'read',
    };

    const joined = await hub.join(candidate);
    if (!joined.ok) {
      close(joined.closeCode, joined.reason);
      return;
    }

    clearTimeout(authTimer);
    token = frame.token;
    session = candidate;
    metrics?.connectionsTotal.inc({ outcome: 'accepted' });

    socket.send(
      JSON.stringify({
        type: 'ready',
        docId: joined.docId,
        mode: candidate.mode,
        bodyKind: authorization.bodyKind,
        schemaVersion: joined.schemaVersion,
      }),
    );

    hub.ready?.(candidate);
  }

  async function recheck(): Promise<void> {
    const current = session;
    if (current === null || token === null) {
      return;
    }

    // The token's own lifetime is a hard bound. The client is told to reconnect - with the
    // fresh token it has long since acquired - rather than being allowed to ride a session
    // whose credential no longer exists.
    const expiry = current.authorization.tokenExpiresAt;
    if (expiry !== null && expiry <= Date.now()) {
      close(CLOSE_CODES.revoked, 'The session token has expired. Reconnect.');
      return;
    }

    const rechecked = await sessions.authenticate(token, current.itemId);
    if (socket.readyState !== WebSocket.OPEN) {
      // The socket closed while the re-check was in flight; there is nothing left to
      // downgrade or revoke.
      return;
    }

    if (!rechecked.ok) {
      close(CLOSE_CODES.revoked, 'This session is no longer authorized.');
      return;
    }

    const fresh = rechecked.value;
    current.authorization = fresh;

    if (!fresh.canWrite && current.mode === 'write') {
      current.mode = 'read';
      socket.send(
        encodeNotice({
          code: 'read_only',
          detail: 'Your access changed to read-only. Edits are no longer accepted.',
        }),
      );
    } else if (fresh.canWrite && current.mode === 'read') {
      current.mode = 'write';
    }
  }

  function close(code: number, reason: string): void {
    metrics?.refusalsTotal.inc({ code: String(code) });
    if (session === null) {
      metrics?.connectionsTotal.inc({ outcome: 'refused' });
    }
    socket.close(code, reason);
  }
}

function rawDataToString(data: RawData): string | null {
  try {
    if (typeof data === 'string') {
      return data;
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString('utf8');
    }
    return Buffer.from(data as ArrayBuffer).toString('utf8');
  } catch {
    return null;
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data);
}
