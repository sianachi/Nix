import { describe, expect, it, vi } from 'vitest';

import { readStdin, resolveSession } from './shared.ts';

describe('resolveSession', () => {
  it('uses the explicit interactive session pair without a stored profile', async () => {
    const session = await resolveSession(undefined, {
      env: {
        XDG_CONFIG_HOME: '/nonexistent/nixctl-test-config',
        NIX_API_URL: 'http://nix.test',
        NIX_SESSION_TOKEN: 'ephemeral-session',
      },
    });

    expect(session.endpoints.apiUrl).toBe('http://nix.test');
    expect(await session.tokens.getAccessToken()).toBe('ephemeral-session');
  });
});

describe('readStdin', () => {
  it('stops buffering when a caller provides a byte limit', async () => {
    const original = process.stdin[Symbol.asyncIterator];
    const iterator = vi.fn(async function* () {
      yield Buffer.from('abcd');
      yield Buffer.from('efgh');
    });
    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: iterator,
    });
    try {
      await expect(readStdin(6)).rejects.toThrow(/exceeds 6 bytes/);
    } finally {
      Object.defineProperty(process.stdin, Symbol.asyncIterator, {
        configurable: true,
        value: original,
      });
    }
  });
});
