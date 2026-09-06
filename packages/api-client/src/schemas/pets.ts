import { z } from 'zod';

export const petProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  appearance: z.enum(['owl', 'cat', 'fox']),
  personality: z.enum(['calm', 'playful', 'encouraging', 'concise']),
  responseLength: z.enum(['concise', 'balanced', 'detailed']),
  instructions: z.string().max(2000),
});

export const petSettingsSchema = z
  .object({
    enabled: z.boolean(),
    activePetId: z.uuid().nullable(),
    motion: z.enum(['system', 'reduced', 'full']),
    narration: z.boolean(),
    profiles: z.array(petProfileSchema).max(12),
  })
  .refine((settings) => {
    const ids = new Set(settings.profiles.map((profile) => profile.id));
    return (
      ids.size === settings.profiles.length &&
      (!settings.enabled || settings.activePetId !== null) &&
      (settings.activePetId === null || ids.has(settings.activePetId))
    );
  }, 'Choose an existing active pet and use unique pet identities.');

export const petSettingsResponseSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  settings: petSettingsSchema,
});

export const petActionSchema = z
  .object({
    kind: z.enum(['rename_item', 'create_item']),
    itemId: z.string(),
    title: z.string().min(1).max(240),
  })
  .refine(
    (action) => action.kind === 'create_item' || z.uuid().safeParse(action.itemId).success,
    'A rename requires a valid item identity.',
  );

export const petMessageSchema = z.object({
  id: z.string().min(1).max(80),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(32000),
  actions: z.array(petActionSchema).max(5),
});

export const petConnectionSchema = z.object({
  provider: z.literal('chatgpt'),
  status: z.enum(['unavailable', 'disconnected', 'connecting', 'connected', 'error']),
  reason: z.string(),
  canConnect: z.boolean(),
  verificationUrl: z
    .union([z.literal(''), z.literal('https://auth.openai.com/codex/device')])
    .default(''),
  userCode: z.string().max(32).default(''),
  state: z.enum(['idle', 'thinking', 'success', 'error']).default('idle'),
  messages: z.array(petMessageSchema).max(41).nullable().default([]),
  history: z
    .array(z.object({ id: z.uuid(), title: z.string().max(240), createdAt: z.iso.datetime() }))
    .max(32)
    .nullable()
    .default([]),
  models: z
    .array(z.object({ id: z.string().max(160), name: z.string().max(200), default: z.boolean() }))
    .max(100)
    .nullable()
    .default([]),
  tools: z
    .array(
      z.object({
        id: z.string().max(200),
        arguments: z.string().max(40000),
        status: z.enum(['pending', 'claimed', 'completed', 'failed', 'interrupted']),
        result: z.string().max(32000),
        claimId: z.string().max(80),
      }),
    )
    .max(20)
    .nullable()
    .default([]),
});

export type PetProfile = z.infer<typeof petProfileSchema>;
export type PetSettings = z.infer<typeof petSettingsSchema>;
export type PetSettingsResponse = z.infer<typeof petSettingsResponseSchema>;
export type PetConnection = z.infer<typeof petConnectionSchema>;
export type PetAction = z.infer<typeof petActionSchema>;
export type PetMessage = z.infer<typeof petMessageSchema>;
export type PetToolCall = NonNullable<z.infer<typeof petConnectionSchema>['tools']>[number];
