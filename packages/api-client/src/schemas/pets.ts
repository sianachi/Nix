import { z } from 'zod';

export const petProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  appearance: z.enum(['owl', 'cat', 'fox', 'eye-of-ra', 'demiurge']),
  personality: z.enum(['calm', 'playful', 'encouraging', 'concise']),
  responseLength: z.enum(['concise', 'balanced', 'detailed']),
  instructions: z.string().max(2000),
});

export const petSettingsSchema = z
  .object({
    enabled: z.boolean(),
    activePetId: z.uuid().nullable(),
    motion: z.enum(['system', 'reduced', 'full']),
    profiles: z.array(petProfileSchema).max(12),
    inlineWriting: z.boolean().default(false),
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

/** One conversation message. A change the pet proposes is a tool call (`tools` below) with its
 * own approval card, never something a message carries. */
export const petMessageSchema = z.object({
  id: z.string().min(1).max(80),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().max(32000),
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
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /**
   * The conversation's model thread holds a tool result read from under a lock. Every write waits
   * for the owner while it is set, in any tab and any later turn; only a new thread clears it.
   * Defaulted, so a server from before the field parses as unmarked.
   */
  lockedRead: z.boolean().default(false),
});

export type PetProfile = z.infer<typeof petProfileSchema>;
export type PetSettings = z.infer<typeof petSettingsSchema>;
export type PetSettingsResponse = z.infer<typeof petSettingsResponseSchema>;
export type PetConnection = z.infer<typeof petConnectionSchema>;
export type PetMessage = z.infer<typeof petMessageSchema>;
export type PetToolCall = NonNullable<z.infer<typeof petConnectionSchema>['tools']>[number];
