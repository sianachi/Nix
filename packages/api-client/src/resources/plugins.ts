import { z } from 'zod';
import type { components } from '../generated/api.js';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  pluginComponentUploadSchema,
  pluginInstallationSchema,
  type PluginCapability,
  type PluginComponentUpload,
  type PluginInstallation,
} from '../schemas/plugins.js';

export type BeginPluginComponentUploadInput =
  components['schemas']['BeginPluginComponentUploadRequest'];
export type RegisterPluginComponentInput =
  components['schemas']['PluginComponentRegistrationRequest'];

export const list = (workspaceId: string): QueryEndpoint<PluginInstallation[]> =>
  defineQuery({
    operation: 'plugins.list',
    path: `/api/v1/workspaces/${workspaceId}/plugins`,
    schema: z.array(pluginInstallationSchema),
    cacheKey: ['plugins', workspaceId],
  });

export const beginComponentUpload = (
  workspaceId: string,
  input: BeginPluginComponentUploadInput,
): CommandEndpoint<PluginComponentUpload> =>
  defineCommand({
    operation: 'plugins.components.upload.begin',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/plugins/components/upload`,
    body: input,
    schema: pluginComponentUploadSchema,
  });

export const register = (
  workspaceId: string,
  input: RegisterPluginComponentInput,
): CommandEndpoint<PluginInstallation> =>
  defineCommand({
    operation: 'plugins.register',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/plugins`,
    body: input,
    schema: pluginInstallationSchema,
    invalidates: [['plugins', workspaceId]],
  });

export const setEnabled = (
  workspaceId: string,
  installationId: string,
  enabled: boolean,
): CommandEndpoint<PluginInstallation> =>
  defineCommand({
    operation: 'plugins.enabled.set',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/plugins/${installationId}/enabled`,
    body: { enabled } satisfies components['schemas']['SetPluginEnabledRequest'],
    schema: pluginInstallationSchema,
    invalidates: [['plugins', workspaceId]],
  });

export const replaceCapabilities = (
  workspaceId: string,
  installationId: string,
  capabilities: readonly PluginCapability[],
): CommandEndpoint<PluginInstallation> =>
  defineCommand({
    operation: 'plugins.capabilities.replace',
    method: 'PUT',
    path: `/api/v1/workspaces/${workspaceId}/plugins/${installationId}/capabilities`,
    body: {
      capabilities: [...capabilities],
    } satisfies components['schemas']['ReplacePluginCapabilitiesRequest'],
    schema: pluginInstallationSchema,
    invalidates: [['plugins', workspaceId]],
  });

export async function putComponent(
  capability: PluginComponentUpload,
  component: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(capability.uploadUrl);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('Plugin upload capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Plugin upload capabilities cannot contain URL credentials.');
  }
  if (Date.parse(capability.expiresAt) <= Date.now()) {
    throw new Error('The plugin upload capability has expired.');
  }

  const response = await fetch(url, {
    method: 'PUT',
    body: component,
    ...(signal === undefined ? {} : { signal }),
    credentials: 'omit',
    redirect: 'error',
    headers: {
      'content-type': 'application/wasm',
      'if-none-match': capability.ifNoneMatch,
      'x-amz-checksum-sha256': capability.xAmzChecksumSha256,
    },
  });
  if (!response.ok) {
    throw new Error(`The plugin component upload failed (${String(response.status)}).`);
  }
}
