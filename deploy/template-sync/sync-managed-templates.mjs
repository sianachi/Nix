import { randomUUID, sign } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const directory = required('NIX_TEMPLATE_BOOT_DIRECTORY');
const workspaceId = required('NIX_TEMPLATE_BOOT_WORKSPACE_ID');
const issuer = strip(required('NIX_TEMPLATE_BOOT_OIDC_ISSUER'));
const audience = required('NIX_TEMPLATE_BOOT_OIDC_AUDIENCE');
const scope = required('NIX_TEMPLATE_BOOT_OIDC_SCOPE');
const serviceKeyFile = required('NIX_TEMPLATE_BOOT_SERVICE_KEY_FILE');
const mediaBaseUrl = strip(required('NIX_TEMPLATE_BOOT_MEDIA_URL'));
const healthUrls = required('NIX_TEMPLATE_BOOT_HEALTH_URLS').split(',').map(strip);
const healthTimeoutMs = positiveInteger(
  process.env.NIX_TEMPLATE_BOOT_HEALTH_TIMEOUT_MS ?? '180000',
  'NIX_TEMPLATE_BOOT_HEALTH_TIMEOUT_MS',
);
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;

if (new URL(issuer).origin !== issuer) {
  throw new Error('NIX_TEMPLATE_BOOT_OIDC_ISSUER must be an origin with no path.');
}
const audienceScope = `urn:zitadel:iam:org:project:id:${audience}:aud`;
if (!scope.split(/\s+/u).includes(audienceScope)) {
  throw new Error('NIX_TEMPLATE_BOOT_OIDC_SCOPE must include the configured project audience.');
}

await waitForHealth(healthUrls, healthTimeoutMs);
const discovery = await publicJson(`${issuer}/.well-known/openid-configuration`);
if (typeof discovery.token_endpoint !== 'string') {
  throw new Error('OIDC discovery did not publish a token_endpoint.');
}
const serviceKey = parseServiceKey(await readFile(serviceKeyFile, 'utf8'));
const tokens = tokenProvider(discovery.token_endpoint, serviceKey);
const names = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.nix'))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (names.length > 200) {
  throw new Error('A managed template directory may contain at most 200 .nix files.');
}

const previews = [];
const stableKeys = new Set();
for (const name of names) {
  const bytes = await readManagedFile(name);
  const previewQuery = new URLSearchParams({ workspaceId });
  const preview = await authorizedJson(`${mediaBaseUrl}/templates/preview?${previewQuery.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: bytes,
  });
  if (typeof preview.digest !== 'string' || typeof preview.profile?.key !== 'string') {
    throw new Error(`The preview response for ${name} was incomplete.`);
  }
  if (stableKeys.has(preview.profile.key)) {
    throw new Error(`Managed template key ${preview.profile.key} is declared by more than one file.`);
  }
  stableKeys.add(preview.profile.key);
  previews.push({ name, digest: preview.digest, stableKey: preview.profile.key });
}

const imports = [];
const pendingOperationIds = [];
try {
  await authorizedJson(
    `${mediaBaseUrl}/workspaces/${workspaceId}/template-stages/expired/sweep`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  for (const preview of previews) {
    const bytes = await readManagedFile(preview.name);
    const query = new URLSearchParams({
      workspaceId,
      managedSource: basename(preview.name),
    });
    const staged = await authorizedJson(
      `${mediaBaseUrl}/templates/managed/stage?${query.toString()}`,
      { method: 'POST', headers: { 'content-type': 'application/zip' }, body: bytes },
    );
    if (typeof staged.operationId === 'string') pendingOperationIds.push(staged.operationId);
    if (staged.digest !== preview.digest || staged.stableKey !== preview.stableKey ||
      typeof staged.templateId !== 'string' ||
      (staged.operationId !== null && typeof staged.operationId !== 'string') ||
      !Array.isArray(staged.writtenTargetItemIds) ||
      !staged.writtenTargetItemIds.every((id) => typeof id === 'string')) {
      throw new Error(`The managed template ${preview.name} changed after directory validation.`);
    }
    imports.push(staged);
  }

  // The only activation point. Core swaps every changed root and retires every absent managed key
  // in one transaction, after checking that this list names every staged operation exactly.
  await authorizedJson(
    `${mediaBaseUrl}/workspaces/${workspaceId}/templates/managed/finalize`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        imports: imports.map((staged) => ({
          operationId: staged.operationId ?? null,
          templateId: staged.templateId,
          stableKey: staged.stableKey,
          digest: staged.digest,
          writtenTargetItemIds: staged.writtenTargetItemIds,
        })),
        activeStableKeys: previews.map((preview) => preview.stableKey),
      }),
    },
  );
} catch (error) {
  await Promise.allSettled(pendingOperationIds.map((operationId) =>
    authorizedJson(`${mediaBaseUrl}/templates/managed/stages/${operationId}`, {
      method: 'DELETE',
    }).catch(() => undefined)));
  throw error;
}

function tokenProvider(tokenEndpoint, key) {
  let current = null;
  return {
    invalidate() { current = null; },
    async get() {
      if (current !== null && current.expiresAt - Date.now() >= 60_000) return current.value;
      const now = Math.floor(Date.now() / 1000);
      const assertion = signedJwt(
        { alg: 'RS256', kid: key.keyId, typ: 'JWT' },
        { iss: key.userId, sub: key.userId, aud: issuer, iat: now, exp: now + 300, jti: randomUUID() },
        key.privateKey,
      );
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          scope,
          assertion,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const answer = await response.json().catch(() => null);
      if (!response.ok || typeof answer?.access_token !== 'string') {
        throw new Error(`OIDC JWT bearer exchange failed with HTTP ${String(response.status)}.`);
      }
      current = {
        value: answer.access_token,
        expiresAt: Date.now() + Number(answer.expires_in ?? 300) * 1000,
      };
      return current.value;
    },
  };
}

async function waitForHealth(urls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (const url of urls) {
    for (;;) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) break;
      } catch {
        // The rollout may still be bringing this dependency up; retry within the one deadline.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${url}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function authorizedJson(url, init, retried = false) {
  const token = await tokens.get();
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 401 && !retried) {
    tokens.invalidate();
    return await authorizedJson(url, init, true);
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof answer?.detail === 'string' ? answer.detail : 'No problem detail returned.';
    throw new Error(`${init.method} ${url} failed with HTTP ${String(response.status)}: ${detail}`);
  }
  return answer ?? {};
}

async function publicJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${String(response.status)}.`);
  return await response.json();
}

async function readManagedFile(name) {
  const path = join(directory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_TEMPLATE_BYTES) {
    throw new Error(`Managed template ${name} is not a regular file of at most 64 MiB.`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new Error(`Managed template ${name} grew beyond 64 MiB while it was read.`);
  }
  return bytes;
}

function parseServiceKey(json) {
  const value = JSON.parse(json);
  if (value?.type !== 'serviceaccount' || typeof value.userId !== 'string' ||
    typeof value.keyId !== 'string' || typeof value.key !== 'string') {
    throw new Error('The mounted OIDC service-account key JSON is invalid.');
  }
  return { userId: value.userId, keyId: value.keyId, privateKey: value.key };
}

function signedJwt(header, payload, privateKey) {
  const input = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function strip(value) {
  return value.replace(/\/+$/, '');
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}
