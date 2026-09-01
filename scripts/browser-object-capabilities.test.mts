import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import webConfig, {
  contentSecurityPolicy,
  parseObjectStorePublicOrigin,
} from '../apps/web/vite.config.ts';

const repo = new URL('../', import.meta.url);

test('accepts one exact safe object-store origin and refuses ambiguous values', () => {
  assert.equal(
    parseObjectStorePublicOrigin('https://objects.example.test:9443/'),
    'https://objects.example.test:9443',
  );
  assert.equal(parseObjectStorePublicOrigin('http://127.0.0.1:7070'), 'http://127.0.0.1:7070');

  for (const value of [
    '',
    ' https://objects.example.test',
    'http://objects.example.test',
    'ftp://objects.example.test',
    'https://user@objects.example.test',
    'https://objects.example.test/storage',
    'https://objects.example.test?mode=public',
    'https://objects.example.test#public',
    'https://one.example.test https://two.example.test',
  ]) {
    assert.throws(() => parseObjectStorePublicOrigin(value));
  }
});

test('the browser CSP admits only self and the configured object-store connection origin', () => {
  const policy = contentSecurityPolicy('https://objects.example.test:9443');
  const connectSource = policy
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src '));

  assert.equal(connectSource, "connect-src 'self' https://objects.example.test:9443");
  assert.doesNotMatch(connectSource ?? '', /(?:^|\s)(?:https:|http:|\*)($|\s)/u);
});

test('Vite removes the fail-closed meta fallback and serves the configured CSP as a header', async () => {
  const html = await readFile(new URL('apps/web/index.html', repo), 'utf8');
  const plugin = webConfig.plugins?.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'name' in candidate &&
      candidate.name === 'nix-configured-content-security-policy',
  );
  assert.ok(plugin !== undefined && typeof plugin === 'object');
  assert.ok('transformIndexHtml' in plugin && typeof plugin.transformIndexHtml === 'function');

  const transformed = plugin.transformIndexHtml(html);
  assert.equal(typeof transformed, 'string');
  assert.doesNotMatch(String(transformed), /http-equiv="Content-Security-Policy"/u);

  const expected = contentSecurityPolicy('http://localhost:7070');
  assert.equal(webConfig.server?.headers?.['Content-Security-Policy'], expected);
  assert.equal(webConfig.preview?.headers?.['Content-Security-Policy'], expected);
});

test('production Caddy policies use the exact configured origin placeholder', async () => {
  for (const path of ['deploy/Caddyfile.prod', 'deploy/k8s/Caddyfile']) {
    const caddyfile = await readFile(new URL(path, repo), 'utf8');
    const policy = /Content-Security-Policy "([^"]+)"/u.exec(caddyfile)?.[1];
    assert.ok(policy !== undefined, `${path} has no CSP header`);
    const connectSource = policy
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('connect-src '));

    assert.equal(
      connectSource,
      "connect-src 'self' {$NIX_OBJECT_STORE_PUBLIC_ORIGIN}",
      `${path} must admit only the configured object-store origin`,
    );
  }
});

test('production Compose gives Core, workers, and Caddy one public-origin contract', async () => {
  const compose = await readFile(new URL('deploy/compose.prod.yml', repo), 'utf8');

  assert.match(
    compose,
    /Nix__ObjectStorage__PublicOrigin: \$\{NIX_OBJECT_STORE_PUBLIC_ORIGIN:\?set NIX_OBJECT_STORE_PUBLIC_ORIGIN\}/u,
  );
  assert.match(
    compose,
    /NIX_OBJECT_STORE_PUBLIC_ORIGIN: \$\{NIX_OBJECT_STORE_PUBLIC_ORIGIN:\?set NIX_OBJECT_STORE_PUBLIC_ORIGIN\}/u,
  );
  assert.equal(
    [
      ...compose.matchAll(
        /NIX_WORKER_OBJECT_ORIGINS: \$\{NIX_OBJECT_STORE_ENDPOINT:\?set NIX_OBJECT_STORE_ENDPOINT\},\$\{NIX_OBJECT_STORE_PUBLIC_ORIGIN:\?set NIX_OBJECT_STORE_PUBLIC_ORIGIN\}/gu,
      ),
    ].length,
    3,
  );
});

test('Kubernetes gives Core, workers, bootstrap, and Caddy one public-origin contract', async () => {
  const [api, workers, bootstrap, web, secrets] = await Promise.all(
    [
      'deploy/k8s/api.yaml',
      'deploy/k8s/worker.yaml',
      'deploy/k8s/job-template-sync.yaml',
      'deploy/k8s/web.yaml',
      'deploy/k8s/create-secrets.sh',
    ].map((path) => readFile(new URL(path, repo), 'utf8')),
  );

  assert.match(api, /Nix__ObjectStorage__PublicOrigin[\s\S]*key: public-origin/u);
  assert.equal(
    [...workers.matchAll(/key: public-origin/gu)].length,
    3,
    'every object-consuming worker role must receive the public origin',
  );
  assert.equal(
    [
      ...workers.matchAll(
        /value: "\$\(NIX_WORKER_OBJECT_ENDPOINT\),\$\(NIX_WORKER_OBJECT_PUBLIC_ORIGIN\)"/gu,
      ),
    ].length,
    3,
  );
  assert.match(bootstrap, /key: public-origin/u);
  assert.match(
    bootstrap,
    /value: "\$\(NIX_TEMPLATE_BOOT_OBJECT_ENDPOINT\),\$\(NIX_TEMPLATE_BOOT_OBJECT_PUBLIC_ORIGIN\)"/u,
  );
  assert.match(web, /NIX_OBJECT_STORE_PUBLIC_ORIGIN[\s\S]*key: public-origin/u);
  assert.match(secrets, /--from-literal=public-origin="\$NIX_OBJECT_STORE_PUBLIC_ORIGIN"/u);
});
