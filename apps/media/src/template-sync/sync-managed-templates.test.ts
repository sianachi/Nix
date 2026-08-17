import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SCRIPT = resolve(process.cwd(), '../../deploy/template-sync/sync-managed-templates.mjs');

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe('managed template boot synchronization', () => {
  it('validates the directory before one atomic no-op/update/removal finalize', async () => {
    const operationId = randomUUID();
    const fixture = await bootFixture([
      { name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId },
      { name: 'beta.nix', bytes: 'beta', key: 'beta', operationId: null },
    ]);

    const result = await fixture.run();

    expect(result.code).toBe(0);
    expect(fixture.events.map((event) => event.kind)).toEqual([
      'health',
      'discovery',
      'token',
      'preview',
      'preview',
      'sweep',
      'stage',
      'stage',
      'finalize',
    ]);
    expect(fixture.finalize).toMatchObject({
      activeStableKeys: ['alpha', 'beta'],
      imports: [
        { stableKey: 'alpha', operationId },
        { stableKey: 'beta', operationId: null },
      ],
    });
  });

  it('aborts the current stage when a file changes after preview', async () => {
    const operationId = randomUUID();
    const fixture = await bootFixture(
      [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId }],
      { changeAfterPreview: { name: 'alpha.nix', bytes: 'changed' } },
    );

    const result = await fixture.run();

    expect(result.code).not.toBe(0);
    expect(fixture.events).toContainEqual({ kind: 'abort', operationId });
    expect(fixture.finalize).toBeNull();
  });

  it('refuses duplicate managed keys before staging', async () => {
    const fixture = await bootFixture([
      { name: 'alpha.nix', bytes: 'alpha', key: 'same', operationId: randomUUID() },
      { name: 'beta.nix', bytes: 'beta', key: 'same', operationId: randomUUID() },
    ]);

    const result = await fixture.run();

    expect(result.code).not.toBe(0);
    expect(fixture.events.some((event) => event.kind === 'stage')).toBe(false);
  });

  it('refuses an invalid service credential without sending the archive to Media', async () => {
    const fixture = await bootFixture(
      [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() }],
      { tokenStatus: 401 },
    );

    const result = await fixture.run();

    expect(result.code).not.toBe(0);
    expect(fixture.events.some((event) => event.kind === 'preview')).toBe(false);
  });

  it('reacquires one access token and retries once after an authorized request returns 401', async () => {
    const fixture = await bootFixture(
      [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: null }],
      { firstAuthorizedRequestStatus: 401 },
    );

    const result = await fixture.run();

    expect(result.code).toBe(0);
    expect(fixture.events.filter((event) => event.kind === 'token')).toHaveLength(2);
    expect(fixture.events.filter((event) => event.kind === 'preview')).toHaveLength(1);
    expect(fixture.events.filter((event) => event.kind === 'finalize')).toHaveLength(1);
  });

  it('refuses an oversized managed file before reading or uploading it', async () => {
    const fixture = await bootFixture([]);
    const oversized = resolve(fixture.directory, 'oversized.nix');
    await writeFile(oversized, '');
    await truncate(oversized, 64 * 1024 * 1024 + 1);

    const result = await fixture.run();

    expect(result.code).not.toBe(0);
    expect(fixture.events.some((event) => event.kind === 'preview')).toBe(false);
  });
});

interface ManagedFile {
  readonly name: string;
  readonly bytes: string;
  readonly key: string;
  readonly operationId: string | null;
}

type Event =
  | { readonly kind: 'health' | 'discovery' | 'token' | 'preview' | 'sweep' | 'stage' | 'finalize' }
  | { readonly kind: 'abort'; readonly operationId: string };

async function bootFixture(
  files: readonly ManagedFile[],
  options: {
    readonly tokenStatus?: number;
    readonly firstAuthorizedRequestStatus?: number;
    readonly changeAfterPreview?: { readonly name: string; readonly bytes: string };
  } = {},
): Promise<{
  readonly directory: string;
  readonly events: Event[];
  readonly finalize: unknown;
  run(): Promise<{ code: number | null; stderr: string }>;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), 'nix-template-boot-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  for (const file of files) await writeFile(resolve(directory, file.name), file.bytes);

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = resolve(directory, 'service-account.json');
  await writeFile(
    keyFile,
    JSON.stringify({
      type: 'serviceaccount',
      userId: randomUUID(),
      keyId: randomUUID(),
      key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );

  const events: Event[] = [];
  let authorizedStatus = options.firstAuthorizedRequestStatus;
  let previewIndex = 0;
  let stageIndex = 0;
  let finalized: unknown = null;
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://placeholder');
    if (url.pathname === '/health') {
      events.push({ kind: 'health' });
      json(response, 200, { status: 'healthy' });
      return;
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      events.push({ kind: 'discovery' });
      json(response, 200, { token_endpoint: `${origin(server)}/token` });
      return;
    }
    if (url.pathname === '/token') {
      events.push({ kind: 'token' });
      json(
        response,
        options.tokenStatus ?? 200,
        options.tokenStatus === 401
          ? { error: 'invalid_grant' }
          : { access_token: 'short-lived-token', expires_in: 300 },
      );
      return;
    }
    if (authorizedStatus !== undefined && request.headers.authorization !== undefined) {
      const status = authorizedStatus;
      authorizedStatus = undefined;
      json(response, status, { detail: 'The access token was rejected.' });
      return;
    }
    if (url.pathname === '/templates/preview') {
      if (url.searchParams.get('workspaceId') !== WORKSPACE) {
        json(response, 400, { detail: 'Preview was not scoped to the workspace.' });
        return;
      }
      const file = files[previewIndex];
      previewIndex += 1;
      const bytes = await body(request);
      if (file === undefined) {
        json(response, 500, { detail: 'Unexpected preview.' });
        return;
      }
      events.push({ kind: 'preview' });
      if (options.changeAfterPreview?.name === file.name) {
        await writeFile(resolve(directory, file.name), options.changeAfterPreview.bytes);
      }
      json(response, 200, {
        digest: digest(bytes),
        profile: { key: file.key },
      });
      return;
    }
    if (url.pathname === '/workspaces/' + WORKSPACE + '/template-stages/expired/sweep') {
      events.push({ kind: 'sweep' });
      json(response, 200, { removed: 0 });
      return;
    }
    if (url.pathname === '/templates/managed/stage') {
      const file = files[stageIndex];
      stageIndex += 1;
      const bytes = await body(request);
      if (file === undefined) {
        json(response, 500, { detail: 'Unexpected stage.' });
        return;
      }
      events.push({ kind: 'stage' });
      json(response, 202, {
        operationId: file.operationId,
        templateId: randomUUID(),
        stableKey: file.key,
        digest: digest(bytes),
        writtenTargetItemIds: [],
      });
      return;
    }
    if (url.pathname === '/workspaces/' + WORKSPACE + '/templates/managed/finalize') {
      events.push({ kind: 'finalize' });
      finalized = JSON.parse((await body(request)).toString('utf8')) as unknown;
      json(response, 200, { activated: 1, unchanged: 1, retired: 1 });
      return;
    }
    const abort = /^\/templates\/managed\/stages\/([0-9a-f-]+)$/i.exec(url.pathname);
    if (request.method === 'DELETE' && abort?.[1] !== undefined) {
      events.push({ kind: 'abort', operationId: abort[1] });
      response.writeHead(204).end();
      return;
    }
    json(response, 404, { detail: 'Unexpected route.' });
  }
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  cleanup.push(() => {
    return new Promise<void>((resolveClose) =>
      server.close(() => {
        resolveClose();
      }),
    );
  });

  return {
    directory,
    events,
    get finalize() {
      return finalized;
    },
    run: () =>
      child(SCRIPT, {
        NIX_TEMPLATE_BOOT_DIRECTORY: directory,
        NIX_TEMPLATE_BOOT_WORKSPACE_ID: WORKSPACE,
        NIX_TEMPLATE_BOOT_MEDIA_URL: origin(server),
        NIX_TEMPLATE_BOOT_OIDC_ISSUER: origin(server),
        NIX_TEMPLATE_BOOT_OIDC_AUDIENCE: 'project-id',
        NIX_TEMPLATE_BOOT_OIDC_SCOPE: 'openid urn:zitadel:iam:org:project:id:project-id:aud',
        NIX_TEMPLATE_BOOT_SERVICE_KEY_FILE: keyFile,
        NIX_TEMPLATE_BOOT_HEALTH_URLS: `${origin(server)}/health`,
        NIX_TEMPLATE_BOOT_HEALTH_TIMEOUT_MS: '1000',
      }),
  };
}

function origin(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The fixture server is not listening.');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const part: unknown = chunk;
    if (typeof part === 'string' || part instanceof Uint8Array) chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function child(
  script: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveChild) => {
    const childProcess = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    childProcess.stderr.setEncoding('utf8');
    childProcess.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    childProcess.on('close', (code) => {
      resolveChild({ code, stderr });
    });
  });
}
