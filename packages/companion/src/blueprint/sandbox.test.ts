import { describe, expect, it } from 'vitest';
import { createFakePorts } from '../testing/fake-ports.js';
import { createSandbox, findSandbox, SANDBOX_TITLE } from './sandbox.js';

describe('blueprint sandbox', () => {
  it('finds the first exact-title root item while ignoring nested matches', async () => {
    const fake = createFakePorts();
    fake.paginate.mockReturnValue(
      (async function* () {
        await Promise.resolve();
        yield { id: 'nested', title: SANDBOX_TITLE, parentId: 'parent' };
        yield { id: 'first', title: SANDBOX_TITLE, parentId: null };
        yield { id: 'second', title: SANDBOX_TITLE, parentId: null };
      })(),
    );

    await expect(findSandbox(fake.ports, 'workspace', fake.signal)).resolves.toEqual({
      id: 'first',
    });
    expect(fake.paginate).toHaveBeenCalledOnce();
    expect(fake.paginate.mock.calls[0]?.[0]).toMatchObject({
      kind: 'paged-query',
      query: { parentId: undefined, includeDeleted: undefined },
      pageSize: 100,
    });
    expect(fake.paginate.mock.calls[0]?.[1]).toMatchObject({ maxPages: 5, signal: fake.signal });
  });

  it('honors the five-page cap when no sandbox appears in the first five pages', async () => {
    const fake = createFakePorts();
    let yielded = 0;
    fake.paginate.mockReturnValue(
      (async function* () {
        await Promise.resolve();
        for (let index = 0; index < 500; index += 1) {
          yielded += 1;
          yield { id: `item-${String(index)}`, title: 'Other', parentId: null };
        }
      })(),
    );

    await expect(findSandbox(fake.ports, 'workspace', fake.signal)).resolves.toBeNull();
    expect(yielded).toBe(500);
  });

  it('creates an ordinary note at the workspace root', async () => {
    const fake = createFakePorts();
    fake.execute.mockResolvedValue({ id: 'sandbox-id' });

    await expect(createSandbox(fake.ports, 'workspace', fake.signal)).resolves.toEqual({
      id: 'sandbox-id',
    });
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(fake.execute.mock.calls[0]?.[0]).toMatchObject({
      kind: 'command',
      method: 'POST',
      body: { type: 'note', title: SANDBOX_TITLE, parentId: null },
    });
  });
});
