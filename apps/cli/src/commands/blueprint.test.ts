import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { outputOptions } from '../output.ts';
import { saveSpecSchema } from '@nix/structure-spec';
import type { Session } from '../session.ts';
import {
  blueprintBuild,
  blueprintSave,
  blueprintValidate,
  evaluateBlueprint,
  executeBlueprintBuild,
  prepareBlueprintSave,
} from './blueprint.ts';

const fixture = fileURLToPath(
  new URL(
    '../../../../packages/structure-spec/fixtures/blueprints/reading-log.json',
    import.meta.url,
  ),
);
const output = outputOptions(true, { isTTY: false });

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('blueprint commands', () => {
  it('prints a validation report and sets exit code on problems', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-blueprint-'));
    try {
      const file = join(dir, 'invalid.json');
      await writeFile(file, JSON.stringify({ version: 1, title: 'Incomplete' }));
      await blueprintValidate(undefined, file, {}, output);
      const report = JSON.parse(lines.join('')) as { ok: boolean; problems: unknown[] };
      expect(report.ok).toBe(false);
      expect(report.problems.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a build before reading its file or opening a session when --yes is absent', async () => {
    await expect(
      blueprintBuild(undefined, '/nonexistent/blueprint.json', {}, output),
    ).rejects.toThrow('--yes');
  });

  it('rejects an invalid save spec before opening a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-save-'));
    try {
      const file = join(dir, 'invalid.json');
      await writeFile(file, JSON.stringify({ includeSamples: 'yes' }));
      await expect(
        blueprintSave(
          undefined,
          '11111111-1111-4111-8111-111111111111',
          file,
          { yes: true, idempotencyKey: 'save-1' },
          output,
        ),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires explicit save approval and a stable retry key before reading the spec', async () => {
    const rootId = '11111111-1111-4111-8111-111111111111';
    const file = '/nonexistent/save-spec.json';
    await expect(blueprintSave(undefined, rootId, file, {}, output)).rejects.toThrow('--yes');
    await expect(blueprintSave(undefined, rootId, file, { yes: true }, output)).rejects.toThrow(
      '--idempotency-key',
    );
  });

  it.each([
    [false, true, 'b'.repeat(64)],
    [true, false, 'a'.repeat(64)],
  ])(
    'pins a Core capture preview for includeSamples=%s',
    async (includeSamples, excludeSamples, expectedCapture) => {
      const rootId = '11111111-1111-4111-8111-111111111111';
      const workspaceId = '22222222-2222-4222-8222-222222222222';
      const queries: { operation: string; path: string }[] = [];
      const session = {
        client: {
          query: vi.fn((endpoint: { operation: string; path: string }) => {
            queries.push(endpoint);
            if (endpoint.operation === 'items.get')
              return Promise.resolve({ id: rootId, workspaceId, title: 'Old title' });
            if (endpoint.operation === 'templates.capture.preview')
              return Promise.resolve({
                fingerprint: 'a'.repeat(64),
                captureFingerprint: expectedCapture,
                sourceTitle: 'Current title',
                itemCount: includeSamples ? 4 : 2,
              });
            throw new Error(`Unexpected query ${endpoint.operation}`);
          }),
        },
      } as unknown as Session;
      const approval = await prepareBlueprintSave(
        session,
        rootId,
        saveSpecSchema.parse({ includeSamples }),
      );
      expect(queries[1]?.path).toContain(`excludeSampleDescendants=${String(excludeSamples)}`);
      expect(approval).toEqual({
        workspaceId,
        title: 'Current title',
        fingerprint: 'a'.repeat(64),
        captureFingerprint: expectedCapture,
      });
    },
  );

  it('validates the reading-log fixture and describes its board', async () => {
    const raw: unknown = JSON.parse(readFileSync(fixture, 'utf8'));
    const result = await evaluateBlueprint(raw, {});
    expect(result.report.ok).toBe(true);
    expect(result.preview?.headline).toContain('Reading Log');
    expect(result.preview?.counts.views).toBeGreaterThan(0);
  });

  it('posts the reading-log board fields and view through the shared build executor', async () => {
    const fixtureBlueprint = JSON.parse(readFileSync(fixture, 'utf8')) as {
      root: { children?: unknown[] };
      inputs?: unknown[];
      rules?: unknown[];
    };
    fixtureBlueprint.root.children = [];
    fixtureBlueprint.inputs = [];
    fixtureBlueprint.rules = [];
    const writes: { operation: string; body: unknown }[] = [];
    const parent = '11111111-1111-4111-8111-111111111111';
    const workspace = '22222222-2222-4222-8222-222222222222';
    const client = {
      async query(endpoint: { operation: string }) {
        await Promise.resolve();
        if (endpoint.operation === 'items.get')
          return { id: parent, workspaceId: workspace, parentId: null, title: 'Parent' };
        if (endpoint.operation === 'schema.get')
          return { properties: [], declared: [], inherit: true };
        throw new Error(`Unexpected query ${endpoint.operation}`);
      },
      async execute(endpoint: { operation: string; body: unknown }) {
        await Promise.resolve();
        writes.push({ operation: endpoint.operation, body: endpoint.body });
        return { item: { id: '33333333-3333-4333-8333-333333333333' } };
      },
    };
    const session = {
      client,
      endpoints: { apiUrl: 'http://nix.test', collabUrl: 'http://collab.nix.test' },
      tokens: { getAccessToken: () => 'token' },
    } as unknown as Session;

    const result = await executeBlueprintBuild(fixtureBlueprint, { parent, yes: true }, session);
    expect(result.complete).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.operation).toBe('items.createStructured');
    expect(writes[0]?.body).toMatchObject({
      title: 'Reading Log',
      parentId: parent,
      schema: { properties: [{ key: 'status' }, { key: 'rating' }] },
    });
    expect(writes[0]?.body).toMatchObject({
      views: { views: [{ kind: 'list' }, { kind: 'board', groupBy: 'status' }] },
    });
  });

  it('writes blueprint note bodies through the authenticated Collaboration origin', async () => {
    const blueprint = JSON.parse(readFileSync(fixture, 'utf8')) as {
      root: { children: { id: string }[] };
      inputs: unknown[];
      rules: unknown[];
    };
    blueprint.root.children = blueprint.root.children.filter((child) => child.id === 'notes');
    blueprint.inputs = [];
    blueprint.rules = [];
    const parent = '11111111-1111-4111-8111-111111111111';
    const workspace = '22222222-2222-4222-8222-222222222222';
    const root = '33333333-3333-4333-8333-333333333333';
    const note = '44444444-4444-4444-8444-444444444444';
    const requests: string[] = [];
    const server = setupServer(
      http.get(`http://collab.nix.test/documents/${note}/updates`, () => {
        requests.push('read');
        return HttpResponse.json({ headSeq: '0', schemaVersion: 1, hasMore: false, updates: [] });
      }),
      http.post(`http://collab.nix.test/documents/${note}/updates`, () => {
        requests.push('append');
        return HttpResponse.json({ seq: '1' });
      }),
    );
    server.listen({ onUnhandledRequest: 'error' });
    try {
      const client = {
        async query(endpoint: { operation: string }) {
          await Promise.resolve();
          if (endpoint.operation === 'items.get')
            return { id: parent, workspaceId: workspace, parentId: null, title: 'Parent' };
          if (endpoint.operation === 'schema.get')
            return { properties: [], declared: [], inherit: true };
          throw new Error(`Unexpected Core query ${endpoint.operation}`);
        },
        async execute(endpoint: { operation: string }) {
          await Promise.resolve();
          if (endpoint.operation === 'items.createStructured') return { item: { id: root } };
          if (endpoint.operation === 'items.create') return { id: note };
          throw new Error(`Unexpected Core command ${endpoint.operation}`);
        },
      };
      const session = {
        client,
        endpoints: { apiUrl: 'http://nix.test', collabUrl: 'http://collab.nix.test' },
        tokens: { getAccessToken: () => 'jwt-1' },
      } as unknown as Session;

      const result = await executeBlueprintBuild(blueprint, { parent, yes: true }, session);
      expect(result.complete).toBe(true);
      expect(requests).toEqual(['read', 'append']);
    } finally {
      server.close();
    }
  });
});
