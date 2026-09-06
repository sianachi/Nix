import { describe, expect, it } from 'vitest';
import { petConnectionSchema, petSettingsSchema } from './pets.js';

const pet = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Owl',
  appearance: 'owl',
  personality: 'playful',
  responseLength: 'balanced',
  instructions: '',
};
const settings = {
  enabled: false,
  activePetId: pet.id,
  motion: 'system',
  narration: false,
  profiles: [pet],
};

describe('pet boundary schemas', () => {
  it('accepts an owl independently of its personality', () => {
    expect(petSettingsSchema.parse(settings).profiles[0]?.personality).toBe('playful');
  });
  it('rejects duplicate identities, unknown designs, and dangling active pets', () => {
    expect(petSettingsSchema.safeParse({ ...settings, profiles: [pet, pet] }).success).toBe(false);
    expect(
      petSettingsSchema.safeParse({ ...settings, profiles: [{ ...pet, appearance: 'fox' }] })
        .success,
    ).toBe(false);
    expect(petSettingsSchema.safeParse({ ...settings, profiles: [] }).success).toBe(false);
    expect(
      petSettingsSchema.safeParse({ ...settings, activePetId: null, enabled: true }).success,
    ).toBe(false);
  });
  it('cannot turn an unsupported provider response into a connected account', () => {
    expect(
      petConnectionSchema.safeParse({
        provider: 'chatgpt',
        status: 'connected',
        reason: '',
        canConnect: true,
      }).success,
    ).toBe(false);
  });
});
