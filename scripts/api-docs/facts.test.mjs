import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function source(path) {
  return readFileSync(join(root, path), 'utf8');
}

function capture(text, pattern) {
  const match = text.match(pattern);
  assert.ok(match, `pattern not found: ${pattern}`);
  return match[1];
}

test('the rate-limit guide quotes the server defaults', () => {
  const program = source('backend/src/Nix.Api/Program.cs');
  const throttle = source('backend/src/Nix.Api/Authentication/FailedAuthenticationThrottle.cs');
  const guide = source('docs/site/nix-docs/markdown/api/rate-limits.md');
  const opening = source('docs/site/nix-docs/markdown/api/index.md');

  const keys = [
    'WritesPerMinute',
    'PublicFormSubmissionsPerMinute',
    'TokenExchangesPerMinute',
    'LockPasswordAttemptsPerMinute',
    'SuggestionsPerMinute',
    'QueriesPerMinute',
  ];
  for (const key of keys) {
    const value = capture(program, new RegExp(`Nix:RateLimits:${key}",\\s*(\\d+)`));
    const phrase = `Nix:RateLimits:${key}\`, default ${value}`;
    assert.ok(guide.includes(phrase), `rate-limits.md missing ${phrase}`);
    assert.ok(opening.includes(phrase), `index.md missing ${phrase}`);
  }

  const failures = capture(throttle, /DefaultLimit = (\d+)/);
  assert.ok(guide.includes(`${failures} failed`));
  const window = capture(throttle, /DefaultWindow = TimeSpan\.FromMinutes\((\d+)\)/);
  assert.ok(guide.includes(`${window} minutes`));
  assert.match(program, /PermitLimit = 6/);
  assert.ok(guide.includes('6 per minute'));
});

test('the auth guide quotes token lifetime, expiry, and the live-token ceiling', () => {
  const minter = source('backend/src/Nix.Api/Authentication/SelfIssuedTokenService.cs');
  const token = source('backend/src/Nix.Api/Domain/Identity/PersonalAccessToken.cs');
  const guide = source('docs/site/nix-docs/markdown/api/authentication.md');
  const minutes = capture(minter, /DefaultLifetimeMinutes = (\d+)/);
  const days = capture(token, /MaximumLifetimeDays = (\d+)/);
  const live = capture(token, /MaximumLiveTokensPerPrincipal = (\d+)/);
  assert.ok(guide.includes(`${minutes} minutes`));
  assert.ok(guide.includes(`1 to ${days} days`));
  assert.ok(guide.includes(`${live} live tokens`));
  assert.ok(guide.includes('/public/v1/auth/token'));
  assert.ok(guide.includes('User-Agent'));
});

test('the pagination guide quotes the cursor and query ceilings', () => {
  const cursor = source('backend/src/Nix.Api/Contracts/CursorPage.cs');
  const query = source('backend/src/Nix.Api/Features/Query/RunItemQuery.cs');
  const workspaceQuery = source('backend/src/Nix.Api/Features/Query/RunWorkspaceQuery.cs');
  const guide = source('docs/site/nix-docs/markdown/api/pagination.md');
  const page = capture(cursor, /public const int DefaultLimit = (\d+);/);
  const max = capture(cursor, /public const int MaximumLimit = (\d+);/);
  const queryDefault = capture(workspaceQuery, /public const int DefaultLimit = (\d+);/);
  const queryMax = capture(query, /public const int MaximumResults = (\d+);/);
  assert.ok(guide.includes(`default ${page}`));
  assert.ok(guide.includes(`at most ${max}`));
  assert.ok(guide.includes(`default ${queryDefault}`));
  assert.ok(guide.includes(`at most ${queryMax}`));
});
