import { describe, expect, it } from 'vitest';

import { InvalidMessage, commandOf, parseEnvelope } from './broker.ts';

// The same ids and command body as `apps/go-workers/internal/broker/contracts_test.go`, so the two
// implementations are held to one contract.
const MESSAGE = '10000000-0000-4000-8000-000000000001';
const TENANT = '20000000-0000-4000-8000-000000000002';

function command(overrides: Record<string, unknown> = {}, raw?: string): string {
  if (raw !== undefined) return raw;
  return JSON.stringify({
    schemaVersion: 1,
    messageId: MESSAGE,
    messageType: 'worker.command.v1',
    occurredAt: '2026-08-31T20:00:00Z',
    tenantId: TENANT,
    workspaceId: null,
    itemId: null,
    kind: 'site.build',
    payload: { jobId: MESSAGE, kind: 'site.build' },
    correlationId: MESSAGE,
    ...overrides,
  });
}

describe('parseEnvelope and commandOf', () => {
  it('accepts a command and names the job', () => {
    const envelope = parseEnvelope(command());
    expect(commandOf(envelope)).toEqual({ jobId: MESSAGE, kind: 'site.build' });
    expect(envelope.traceParent).toBeNull();
  });

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['an unknown field', { extra: true }],
    ['a missing payload', { payload: null }],
    ['an untrimmed kind', { kind: ' site.build' }],
    ['a bad timestamp', { occurredAt: 'yesterday' }],
    ['a causation id without depth', { causationId: '50000000-0000-4000-8000-000000000005' }],
    ['a depth without a causation id', { causationDepth: 1 }],
    [
      'a depth past the bound',
      { causationDepth: 5, causationId: '50000000-0000-4000-8000-000000000005' },
    ],
    ['a non-positive aggregate version', { aggregateVersion: 0 }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => parseEnvelope(command(overrides))).toThrow(InvalidMessage);
  });

  it('rejects an empty or oversized body and anything that is not an object', () => {
    expect(() => parseEnvelope('')).toThrow(InvalidMessage);
    expect(() => parseEnvelope(command(), 10)).toThrow(InvalidMessage);
    expect(() => parseEnvelope('[1]')).toThrow(InvalidMessage);
    expect(() => parseEnvelope('not json')).toThrow(InvalidMessage);
  });

  it('rejects a duplicate member, which JSON.parse would let the last one win', () => {
    const body = command({}, `{"schemaVersion":1,"schemaVersion":1,"messageId":"${MESSAGE}"}`);
    expect(() => parseEnvelope(body)).toThrow(/duplicate/);
  });

  it('rejects nesting beyond the depth bound', () => {
    const deep = '['.repeat(13) + ']'.repeat(13);
    expect(() => parseEnvelope(command({ payload: JSON.parse(deep) }))).toThrow(/depth/);
  });

  it('rejects a command whose reference disagrees with the envelope', () => {
    expect(() => commandOf(parseEnvelope(command({ messageType: 'workspace.event.v1' })))).toThrow(
      InvalidMessage,
    );
    expect(() => commandOf(parseEnvelope(command({ correlationId: TENANT })))).toThrow(
      InvalidMessage,
    );
    expect(() =>
      commandOf(parseEnvelope(command({ payload: { jobId: MESSAGE, kind: 'site.purge' } }))),
    ).toThrow(InvalidMessage);
    expect(() => commandOf(parseEnvelope(command({ payload: { kind: 'site.build' } })))).toThrow(
      InvalidMessage,
    );
  });
});
