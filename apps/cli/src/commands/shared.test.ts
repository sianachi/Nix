import { describe, expect, it } from 'vitest';

import { resolveSession } from './shared.ts';

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
