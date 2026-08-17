import { describe, expect, it } from 'vitest';

import { assertNoDatabaseCredentials, readConfig } from './config.ts';

/**
 * Starting up, and refusing to.
 *
 * The credential check is the one worth writing tests for: it is a rule the architecture depends on,
 * stated in two documents, and the failure it prevents - a deployment manifest copied from the
 * collaboration service - is silent everywhere else.
 */

const MINIMAL = {
  NIX_MEDIA_COLLAB_BASE_URL: 'http://localhost:8100',
  NIX_MEDIA_INTERNAL_SECRET: 'secret',
} satisfies NodeJS.ProcessEnv;

describe('holding no database credentials, ever', () => {
  it('refuses to start when a database URL is in the environment', () => {
    expect(() => {
      assertNoDatabaseCredentials({ DATABASE_URL: 'postgresql://localhost/nix' });
    }).toThrow(/holds no database credentials/);
  });

  it('refuses one wearing this service prefix, which is how a copied manifest arrives', () => {
    expect(() => {
      assertNoDatabaseCredentials({ NIX_MEDIA_DATABASE_URL: 'postgresql://localhost/nix' });
    }).toThrow(/looks like a database credential/);
  });

  it('refuses the loose Postgres variables a client library would pick up on its own', () => {
    expect(() => {
      assertNoDatabaseCredentials({ PGHOST: 'localhost' });
    }).toThrow(/holds no database credentials/);
  });

  it('names the variable, so the fix does not need a search', () => {
    expect(() => {
      assertNoDatabaseCredentials({ PGPASSWORD: 'hunter2' });
    }).toThrow(/^PGPASSWORD is set/);
  });

  it('is untroubled by an empty one, which is how an unset value often arrives', () => {
    expect(() => {
      assertNoDatabaseCredentials({ DATABASE_URL: '' });
    }).not.toThrow();
  });

  it('runs before anything else, so a bad environment never half-starts a service', () => {
    expect(() => readConfig({ ...MINIMAL, DATABASE_URL: 'postgresql://localhost/nix' })).toThrow(
      /holds no database credentials/,
    );
  });
});

describe('reading the configuration', () => {
  it('will not start without knowing where the documents come from', () => {
    expect(() => readConfig({ NIX_MEDIA_INTERNAL_SECRET: 'secret' })).toThrow(
      'NIX_MEDIA_COLLAB_BASE_URL is required. The media service will not start without it.',
    );
  });

  it('will not start without the secret that says which service it is', () => {
    expect(() => readConfig({ NIX_MEDIA_COLLAB_BASE_URL: 'http://localhost:8100' })).toThrow(
      /NIX_MEDIA_INTERNAL_SECRET is required/,
    );
  });

  it('takes a base URL with a trailing slash without producing a double one', () => {
    const config = readConfig({ ...MINIMAL, NIX_MEDIA_COLLAB_BASE_URL: 'http://localhost:8100/' });

    expect(config.collabBaseUrl).toBe('http://localhost:8100');
  });

  it('has working defaults for every bound, so a minimal environment is a safe one', () => {
    const config = readConfig(MINIMAL);

    expect(config.port).toBe(8200);
    expect(config.jobTimeoutMs).toBeGreaterThan(0);
    expect(config.maxConcurrentExports).toBeGreaterThan(0);
    expect(config.maxConcurrentTemplateParses).toBeGreaterThan(0);
    expect(config.maxOutputBytes).toBeGreaterThan(0);
  });
});
