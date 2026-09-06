import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import {
  petConnectionSchema,
  petSettingsResponseSchema,
  type PetSettings,
  type PetSettingsResponse,
  type PetConnection,
} from '../schemas/pets.js';

const settingsKey = ['me', 'pets', 'settings'] as const;

export const settings = (): QueryEndpoint<PetSettingsResponse> =>
  defineQuery({
    operation: 'pets.settings',
    path: '/api/v1/me/pets/settings',
    schema: petSettingsResponseSchema,
    cacheKey: settingsKey,
  });

export const saveSettings = (
  expectedRevision: number,
  value: PetSettings,
): CommandEndpoint<PetSettingsResponse> =>
  defineCommand({
    operation: 'pets.saveSettings',
    method: 'PUT',
    path: '/api/v1/me/pets/settings',
    schema: petSettingsResponseSchema,
    body: {
      expectedRevision,
      settings: value,
    } satisfies components['schemas']['SavePetSettingsRequest'],
    invalidates: [settingsKey],
  });

export const connection = (): QueryEndpoint<PetConnection> =>
  defineQuery({
    operation: 'pets.connection',
    path: '/api/v1/me/pets/connection',
    schema: petConnectionSchema,
    cacheKey: ['me', 'pets', 'connection'],
  });

export interface RuntimeInput {
  readonly operation:
    | 'status'
    | 'connect'
    | 'disconnect'
    | 'models'
    | 'read'
    | 'send'
    | 'interrupt'
    | 'reset'
    | 'tool_claim'
    | 'tool_result'
    | 'history'
    | 'read_history'
    | 'delete_history';
  readonly workspaceId?: string;
  readonly petId?: string;
  readonly requestId?: string;
  readonly text?: string;
  readonly itemId?: string;
  readonly sharedText?: string;
  readonly model?: string;
  readonly workspaceAccess?: boolean;
  readonly toolId?: string;
  readonly toolResult?: string;
  readonly toolSuccess?: boolean;
  readonly historyId?: string;
}

export const runtime = (input: RuntimeInput): CommandEndpoint<PetConnection> =>
  defineCommand({
    operation: 'pets.runtime',
    method: 'POST',
    path: '/api/v1/me/pets/runtime',
    schema: petConnectionSchema,
    body: {
      ...input,
      text: input.text ?? '',
      sharedText: input.sharedText ?? '',
      model: input.model ?? '',
      workspaceAccess: input.workspaceAccess ?? false,
      toolId: input.toolId ?? '',
      toolResult: input.toolResult ?? '',
      toolSuccess: input.toolSuccess ?? false,
    } satisfies components['schemas']['PetRuntimeRequest'],
    invalidates: [['me', 'pets', 'connection']],
  });
