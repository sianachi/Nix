import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { outputOptions } from '../output.ts';
import type { Session } from '../session.ts';
import {
  blueprintBuild,
  blueprintSave,
  blueprintValidate,
  evaluateBlueprint,
  executeBlueprintBuild,
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
});
