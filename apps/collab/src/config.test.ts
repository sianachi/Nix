import { describe, expect, it } from 'vitest';

import { FORBIDDEN_DATABASE_ROLES, assertRuntimeRole, readConfig } from './config.ts';

const base = {
  NIX_COLLAB_DATABASE_URL: 'postgresql://nix_collab:secret@localhost:5433/nix',
  NIX_COLLAB_CORE_BASE_URL: 'http://localhost:5014/',
  NIX_COLLAB_OIDC_ISSUER: 'http://localhost:8300/',
  NIX_COLLAB_OIDC_AUDIENCE: 'nix-api',
};

describe('configuration', () => {
  it('reads what the service needs and defaults the rest', () => {
    const config = readConfig(base);

    expect(config.port).toBe(8100);
    expect(config.snapshotEvery).toBe(50);
  });

  it('strips trailing slashes so URLs are joined without doubling one', () => {
    const config = readConfig(base);

    expect(config.coreBaseUrl).toBe('http://localhost:5014');
    expect(config.oidcIssuer).toBe('http://localhost:8300');
  });

  it.each(['NIX_COLLAB_CORE_BASE_URL', 'NIX_COLLAB_OIDC_ISSUER', 'NIX_COLLAB_OIDC_AUDIENCE'])(
    'refuses to start without %s',
    (key) => {
      const env = { ...base, [key]: '' };

      // Fail-fast rather than lazily: a process that starts happily and refuses every request
      // when somebody finally opens a document is harder to diagnose than one that never starts.
      expect(() => readConfig(env)).toThrow(key);
    },
  );

  it.each(FORBIDDEN_DATABASE_ROLES)('refuses to connect as %s', (role) => {
    expect(() => {
      assertRuntimeRole(`postgresql://${role}:secret@localhost:5433/nix`);
    }).toThrow(/Refusing to start/);
  });

  it('names nix_migrator among the forbidden roles, because it can bypass row-level security', () => {
    // A service connected as that role would read every tenant's rows through policies that
    // are still, technically, present and correct - so nothing would look wrong until it did.
    expect(FORBIDDEN_DATABASE_ROLES).toContain('nix_migrator');

    // And nix_app, which is Core's role: it holds SELECT on the content tables and nothing
    // more, so connecting as it would fail every write, late and confusingly.
    expect(FORBIDDEN_DATABASE_ROLES).toContain('nix_app');
  });

  it('accepts the collaboration role', () => {
    expect(() => {
      assertRuntimeRole(base.NIX_COLLAB_DATABASE_URL);
    }).not.toThrow();
  });
});
