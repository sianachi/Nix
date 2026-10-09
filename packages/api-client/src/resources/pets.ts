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
  /** With a tool result: the result came from an item under a lock (marks the conversation). */
  readonly toolLockedContent?: boolean;
  readonly historyId?: string;
  readonly mode?: 'chat' | 'consult';
  /** The owner's own day, `yyyy-MM-dd` in `timeZone`, so the model can resolve relative dates. */
  readonly today?: string;
  /** The owner's IANA time zone. */
  readonly timeZone?: string;
  /** The workspace's main containers, sent with a conversation's first message only. */
  readonly workspaceMap?: readonly PetWorkspaceMapEntry[];
}

/** One container a conversation's first message describes to the model. */
export interface PetWorkspaceMapEntry {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** Left out when the client does not know the container's views. */
  readonly viewKinds?: readonly string[];
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
      toolLockedContent: input.toolLockedContent ?? false,
      mode: input.mode ?? '',
      today: input.today ?? '',
      timeZone: input.timeZone ?? '',
      workspaceMap:
        input.workspaceMap?.map((entry) => ({
          ...entry,
          viewKinds: entry.viewKinds === undefined ? null : [...entry.viewKinds],
        })) ?? null,
    } satisfies components['schemas']['PetRuntimeRequest'],
    invalidates: [['me', 'pets', 'connection']],
  });

export interface WatchRuntimeInput {
  readonly workspaceId: string;
  readonly petId: string;
  readonly mode?: 'chat' | 'consult';
  /** The caller's last known revision; the server waits for a change past it. */
  readonly after?: number;
}

/**
 * The GET long-poll counterpart to `runtime`: never a write, never rate limited by the
 * writes policy, and never de-duplicated the way a cached query would be, since each call
 * carries a different `after`.
 */
export const watchRuntime = (input: WatchRuntimeInput): QueryEndpoint<PetConnection> =>
  defineQuery({
    operation: 'pets.watchRuntime',
    // Core waits up to 20 seconds; the ordinary 15-second read budget ends too early.
    timeoutMs: 35_000,
    path: '/api/v1/me/pets/runtime/watch',
    schema: petConnectionSchema,
    query: {
      workspaceId: input.workspaceId,
      petId: input.petId,
      ...(input.mode ? { mode: input.mode } : {}),
      after: input.after ?? 0,
    },
  });
