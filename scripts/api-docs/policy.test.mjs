import assert from 'node:assert/strict';
import test from 'node:test';

import { serverErrorCodes } from '../generate-api-docs.mjs';
import { capability } from './capability.mjs';
import { classify, tokenScope } from './scope.mjs';

test('reads stay read, and a token cannot mint tokens', () => {
  assert.equal(classify('GET', '/api/v1/workspaces'), 'read');
  assert.equal(classify('GET', '/api/v1/items/{itemId}'), 'read');
  assert.equal(classify('POST', '/api/v1/me/tokens'), 'interactive');
  assert.equal(classify('DELETE', '/api/v1/me/tokens/{tokenId}'), 'interactive');
  assert.equal(classify('POST', '/api/v1/search/mentions'), 'read');
  assert.equal(classify('POST', '/api/v1/workspaces/{workspaceId}/query'), 'read');
  assert.equal(classify('POST', '/api/v1/workspaces/{workspaceId}/query/aggregate'), 'read');
  assert.equal(classify('POST', '/api/v1/items/{itemId}/move'), 'admin');
  assert.equal(classify('GET', '/api/v1/items/{itemId}/move-workspaces'), 'read');
  assert.equal(classify('POST', '/api/v1/sites'), 'admin');
  assert.equal(classify('GET', '/api/v1/sites/{siteId}'), 'read');
  assert.equal(classify('POST', '/api/v1/me/calendar/links/{linkId}/sync'), 'write');
  assert.equal(classify('POST', '/api/v1/me/calendar/links'), 'admin');
  assert.equal(classify('PUT', '/api/v1/me/preferences'), 'interactive');
  assert.equal(classify('GET', '/api/v1/me/preferences'), 'read');
});

test('health, exchange, and public forms are not bearer scopes', () => {
  assert.equal(tokenScope('GET', '/healthz'), 'public');
  assert.equal(tokenScope('POST', '/public/v1/auth/token'), 'public');
  assert.equal(tokenScope('GET', '/public/v1/auth/jwks'), 'public');
  assert.equal(tokenScope('POST', '/public/v1/forms/{token}'), 'public');
  assert.equal(tokenScope('PATCH', '/api/v1/items/{itemId}'), 'write');
});

test('renaming an item does not edit a note body', () => {
  const effect = capability('PATCH', '/api/v1/items/{itemId}');
  assert.match(effect.can, /title/);
  assert.match(effect.cannot, /note body/);
  assert.match(effect.cannot, /no REST route/);
});

test('creating an item does not send a body', () => {
  const effect = capability('POST', '/api/v1/workspaces/{workspaceId}/items');
  assert.match(effect.can, /Create an item/);
  assert.match(effect.cannot, /spreadsheet body/);
});

test('server error codes include item failures and omit the internal boundary', () => {
  const codes = serverErrorCodes(new URL('../../backend/src/Nix.Api', import.meta.url).pathname);
  assert.ok(codes.includes('items.not_found'));
  assert.ok(codes.includes('items.idempotency_conflict'));
  assert.equal(codes.includes('internal.not_found'), false);
  assert.equal(codes.includes('worker.execution_refused'), false);
});

test('the exchange mints a session and does not mint a personal access token', () => {
  const effect = capability('POST', '/public/v1/auth/token');
  assert.match(effect.can, /bearer JWT/i);
  assert.match(effect.cannot, /does not change workspace data/i);
});
