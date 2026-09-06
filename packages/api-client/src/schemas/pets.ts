import { z } from 'zod';

export const petProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  appearance: z.literal('owl'),
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

export const petConnectionSchema = z.object({
  provider: z.literal('chatgpt'),
  status: z.literal('unavailable'),
  reason: z.string(),
  canConnect: z.literal(false),
});

export type PetProfile = z.infer<typeof petProfileSchema>;
export type PetSettings = z.infer<typeof petSettingsSchema>;
export type PetSettingsResponse = z.infer<typeof petSettingsResponseSchema>;
export type PetConnection = z.infer<typeof petConnectionSchema>;
