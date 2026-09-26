import { vi } from 'vitest';
import type { NixClient } from '@nix/api-client';
import type { CompanionBodies, CompanionClock, CompanionIds, CompanionPorts } from '../ports.js';

/** `core` and `bodies` are excluded: this fake's `query`/`execute`/`paginate`/`bodies`
 * spies are wired to the `ports` it returns, and overriding either port here would
 * silently detach the returned spies from what the executor actually calls. */
type FakePortOverrides = Partial<Pick<CompanionPorts, 'collab' | 'clock' | 'ids'>>;

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
}

export interface FakePorts {
  ports: CompanionPorts;
  query: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  paginate: ReturnType<typeof vi.fn>;
  bodies: { read: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  signal: AbortSignal;
}

/** The I/O fake for @nix/companion's ports: an in-memory client, a fixed clock
 * (2026-09-25, Europe/London) and sequential ids, so a test never touches a
 * real clock, a real id generator or a real Nix client. */
export function createFakePorts(overrides?: FakePortOverrides): FakePorts {
  const query = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn().mockResolvedValue(undefined);
  const paginate = vi.fn(() => emptyAsyncIterable());
  const client = { query, execute, paginate } as unknown as NixClient;
  const bodies: CompanionBodies = { read: vi.fn(), append: vi.fn() };
  const clock: CompanionClock = {
    today: () => '2026-09-25',
    timeZone: () => 'Europe/London',
    now: () => new Date('2026-09-25T09:00:00.000Z'),
  };
  let nextId = 1;
  const ids: CompanionIds = {
    uuid: () => String(nextId++).padStart(8, '0') + '-0000-4000-8000-000000000000',
  };
  const ports: CompanionPorts = {
    core: client,
    collab: client,
    bodies,
    clock,
    ids,
    ...overrides,
  };
  return {
    ports,
    query,
    execute,
    paginate,
    bodies: bodies as { read: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> },
    signal: new AbortController().signal,
  };
}
