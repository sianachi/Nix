import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ObjectTransfer, TransferError } from './object-transfer.ts';

let server: Server | null = null;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  const closing = server;
  server = null;
  closing?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (closing === null) resolve();
    else
      closing.close(() => {
        resolve();
      });
  });
});

describe('ObjectTransfer', () => {
  it('refuses an origin that is not allowed, and admits only loopback when none are configured', async () => {
    expect(new ObjectTransfer({ origins: [] }).permits('http://127.0.0.1:7070/x')).toBe(true);
    expect(new ObjectTransfer({ origins: [] }).permits('https://objects.example.test/x')).toBe(
      false,
    );
    const pinned = new ObjectTransfer({ origins: ['https://objects.example.test:9443'] });
    expect(pinned.permits('https://objects.example.test:9443/x?sig=1')).toBe(true);
    expect(pinned.permits('https://other.example.test/x')).toBe(false);
    await expect(pinned.download('https://other.example.test/x', 10)).rejects.toThrow(/origin/);
  });

  it('stops a download at its byte bound', async () => {
    const base = await listen((_request, response) => response.end('0123456789'));
    const transfer = new ObjectTransfer({ origins: [] });
    expect(Buffer.from(await transfer.download(`${base}/o`, 10)).toString()).toBe('0123456789');
    await expect(transfer.download(`${base}/o`, 4)).rejects.toThrow(/byte limit/);
  });

  it('does not follow redirects', async () => {
    const base = await listen((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/secret' }).end();
    });
    await expect(new ObjectTransfer({ origins: [] }).download(`${base}/o`, 10)).rejects.toThrow(
      /redirect/,
    );
  });

  it('never puts the capability query in an error', async () => {
    const base = await listen((_request, response) => response.writeHead(500).end());
    const failure = await new ObjectTransfer({ origins: [] })
      .download(`${base}/o?X-Amz-Signature=super-secret`, 10)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransferError);
    expect((failure as Error).message).not.toContain('super-secret');
  });

  it('sends the storage checksum and the create-only precondition, and treats 412 as written', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const base = await listen((request, response) => {
      seen.push({
        checksum: request.headers['x-amz-checksum-sha256'] as string | undefined,
        precondition: request.headers['if-none-match'],
        length: request.headers['content-length'],
      });
      request.resume();
      response.writeHead(seen.length === 1 ? 200 : 412).end();
    });
    const transfer = new ObjectTransfer({ origins: [] });
    const bytes = Buffer.from('body');
    expect(await transfer.putCreateOnly(`${base}/o`, bytes)).toBe('created');
    expect(await transfer.putCreateOnly(`${base}/o`, bytes)).toBe('exists');
    expect(seen[0]).toEqual({
      checksum: createHash('sha256').update(bytes).digest('base64'),
      precondition: '*',
      length: '4',
    });
  });

  it('sends no precondition when replacing, and treats 412 as a failure', async () => {
    let precondition: string | undefined = 'unset';
    const base = await listen((request, response) => {
      precondition = request.headers['if-none-match'];
      request.resume();
      response.writeHead(request.url === '/ok' ? 200 : 412).end();
    });
    const transfer = new ObjectTransfer({ origins: [] });
    await transfer.putReplacing(`${base}/ok`, Buffer.from('x'));
    expect(precondition).toBeUndefined();
    await expect(transfer.putReplacing(`${base}/no`, Buffer.from('x'))).rejects.toThrow(/412/);
  });
});
