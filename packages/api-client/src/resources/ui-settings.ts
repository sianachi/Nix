import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  uiSettingsResponseSchema,
  type UiSettingsPatch,
  type UiSettingsResponse,
} from '../schemas/ui-settings.js';

const uiSettingsKey = ['me', 'ui-settings'] as const;

/** The caller's own synced interface settings; empty at revision 0 when never saved. */
export const settings = (): QueryEndpoint<UiSettingsResponse> =>
  defineQuery({
    operation: 'uiSettings.get',
    path: '/api/v1/me/ui-settings',
    schema: uiSettingsResponseSchema,
    cacheKey: uiSettingsKey,
  });

/** Merges per key: a value sets the key, `null` deletes it, other keys are untouched. */
export const patchSettings = (patch: UiSettingsPatch): CommandEndpoint<UiSettingsResponse> =>
  defineCommand({
    operation: 'uiSettings.patch',
    method: 'PATCH',
    path: '/api/v1/me/ui-settings',
    schema: uiSettingsResponseSchema,
    // The generated body type is `Record<string, never>` (a free-form dictionary), so `UiSettingsPatch` is the contract here.
    body: { settings: patch },
    invalidates: [uiSettingsKey],
  });
