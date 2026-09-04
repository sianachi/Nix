'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_DEV_URL, isSafeExternalUrl, normalizeUrl, resolveWebUrl } = require('./config.cjs');

test('development defaults to the Vite web server', () => {
  assert.equal(resolveWebUrl({ isPackaged: false, env: {}, args: [] }), DEFAULT_DEV_URL);
});

test('packaged builds require an explicit server URL', () => {
  assert.throws(
    () => resolveWebUrl({ isPackaged: true, env: {}, args: [] }),
    /server URL is not configured/,
  );
});

test('the command line URL takes precedence and removes a trailing slash', () => {
  assert.equal(
    resolveWebUrl({
      isPackaged: true,
      env: { NIX_DESKTOP_WEB_URL: 'https://env.example/' },
      args: ['--web-url=https://command.example/'],
    }),
    'https://command.example',
  );
});

test('only HTTP(S) server URLs are accepted', () => {
  assert.throws(() => normalizeUrl('file:///tmp/nix'), /must use http or https/);
  assert.throws(() => normalizeUrl('not a URL'), /not valid/);
});

test('external navigation excludes local and executable protocols', () => {
  assert.equal(isSafeExternalUrl('https://nix.example.test/help'), true);
  assert.equal(isSafeExternalUrl('mailto:support@nix.example.test'), true);
  assert.equal(isSafeExternalUrl('file:///tmp/nix'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
});
