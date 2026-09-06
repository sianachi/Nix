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
