import type { AddressInfo } from 'node:net';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocketServer } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { encodePersisted as serverEncodePersisted } from '../../../collab/src/ws/protocol.ts';
import {
  checkMarkers,
  connect,
  decodePersisted,
  encodePersisted,
  guardTarget,
} from './collab-stress.ts';

const endpoints = (apiUrl: string, collabUrl: string) => ({ apiUrl, collabUrl, mediaUrl: apiUrl });

describe('collab-edit framing', () => {
  it('encodes the persisted barrier exactly as the collab service does, and decodes it back', () => {
    expect(encodePersisted('nxabc-c0-e1')).toEqual(serverEncodePersisted('nxabc-c0-e1'));
    expect(decodePersisted(encodePersisted('nxabc-c0-e1'))).toBe('nxabc-c0-e1');
    expect(decodePersisted(new Uint8Array([0, 1, 0]))).toBeNull();
  });
});

describe('checkMarkers', () => {
  const body = 'intro\n\nnx1-c0-e1\n\nnx1-c0-e10\n\nnx1-c1-e0\n\nnx1-c1-e0\n\nother-c0-e3';

  it('reports lost markers and does not match one marker inside another', () => {
    const result = checkMarkers(body, 'nx1', ['nx1-c0-e1', 'nx1-c0-e2', 'nx1-c0-e10', 'nx1-c1-e0']);
    expect(result.lost).toEqual(['nx1-c0-e2']);
  });

  it('reports a marker that appears more than once', () => {
    expect(checkMarkers(body, 'nx1', ['nx1-c1-e0']).duplicated).toEqual(['nx1-c1-e0']);
  });

  it('is clean when every expected marker is present once', () => {
    expect(checkMarkers('nx1-c0-e0\n\nnx1-c0-e1', 'nx1', ['nx1-c0-e0', 'nx1-c0-e1'])).toEqual({
      lost: [],
      duplicated: [],
    });
  });
});

describe('guardTarget', () => {
  it('allows loopback targets silently', () => {
    expect(guardTarget(endpoints('http://localhost:5014', 'http://127.0.0.1:8100'), false)).toBe(
      undefined,
    );
  });

  it('refuses a remote api or collab host without --allow-remote', () => {
    expect(() =>
      guardTarget(endpoints('https://nix.example.com', 'http://localhost:8100'), false),
    ).toThrow(/--allow-remote/);
    expect(() =>
      guardTarget(endpoints('http://localhost:5014', 'https://nix.example.com/collab'), false),
    ).toThrow(/--allow-remote/);
  });

  it('warns but proceeds when remote is allowed', () => {
    expect(
      guardTarget(endpoints('https://nix.example.com', 'https://nix.example.com'), true),
    ).toMatch(/remote target/);
  });
});

describe('collab-edit client against a minimal in-process collab server', () => {
  it('syncs two peers, delivers each edit to the server and the other peer, and gets the barrier', async () => {
    const serverDoc = new Y.Doc();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket) => {
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          const auth = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
          expect(auth).toEqual({ type: 'auth', token: 't', schemaVersion: 1 });
          socket.send(JSON.stringify({ type: 'ready' }));
          const step1 = encoding.createEncoder();
          encoding.writeVarUint(step1, 0);
          syncProtocol.writeSyncStep1(step1, serverDoc);
          socket.send(encoding.toUint8Array(step1));
          return;
        }
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) === 3) {
          socket.send(serverEncodePersisted(decoding.readVarString(decoder)));
          return;
        }
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        syncProtocol.readSyncMessage(decoder, reply, serverDoc, socket);
        if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
      });
    });
    serverDoc.on('update', (update: Uint8Array, origin: unknown) => {
      const frame = encoding.createEncoder();
      encoding.writeVarUint(frame, 0);
      syncProtocol.writeUpdate(frame, update);
      for (const client of wss.clients) {
        if (client !== origin) client.send(encoding.toUint8Array(frame));
      }
    });

    await new Promise((done) => wss.once('listening', done));
    const url = `ws://127.0.0.1:${String((wss.address() as AddressInfo).port)}`;
    const tally = { closeCodes: {}, notices: {} };
    const [a, b] = await Promise.all([connect(url, 't', tally), connect(url, 't', tally)]);
    await a.edit('m-a');
    await b.edit('m-b');
    await a.edit('m-a2');

    const text = (doc: Y.Doc): string => doc.getXmlFragment('default').toJSON();
    for (const marker of ['m-a', 'm-b', 'm-a2']) expect(text(serverDoc)).toContain(marker);
    // The broadcast reaches the other peer a moment after the barrier; give it one tick.
    await new Promise((done) => setTimeout(done, 50));
    expect(text(a.doc)).toContain('m-b');
    expect(text(b.doc)).toContain('m-a2');
    expect(tally).toEqual({ closeCodes: {}, notices: {} });

    a.close();
    b.close();
    wss.close();
  });
});
